import Foundation

// Ask: the screen hands a request to the owner's agent, which answers in a
// conversation kept by Yolo (Agent Notes 2026-10-18-agent-from-the-screen and
// 2026-10-18-multi-agent-conversations). The answer streams back as NDJSON;
// the screen shows the current step and the final sentence, never the
// agent's words along the way.

/// One line of an answer's stream.
public enum AgentEvent: Sendable, Equatable {
  /// First on the conversation route: the conversation this answer is in.
  case conversation(id: String, title: String?)
  /// The agent called a tool (Yolo's MCP names, or WebSearch/WebFetch).
  case tool(String)
  /// The agent's words along the way, which the screen does not show.
  case text(String)
  case done(String)
  case error(String)

  public init?(line: String) {
    guard let value = try? JSONValue.parse(line), let type = value["type"]?.string else { return nil }
    switch type {
    case "conversation":
      guard let id = value["id"]?.string else { return nil }
      self = .conversation(id: id, title: value["title"]?.string)
    case "tool": self = .tool(value["name"]?.string ?? "")
    case "text": self = .text(value["text"]?.string ?? "")
    case "done": self = .done(value["text"]?.string ?? "")
    case "error": self = .error(value["error"]?["message"]?.string ?? "The agent could not do that.")
    default: return nil
    }
  }

  /// The step a tool call shows, as the player's `STEPS`.
  public static func step(for tool: String) -> String {
    switch tool {
    case "search": "Searching your libraries…"
    case "browse": "Looking through your libraries…"
    case "WebSearch": "Searching the web…"
    case "WebFetch": "Reading a page…"
    case "play": "Starting it…"
    case "queue_add", "playlist_enqueue": "Adding it to the queue…"
    case "control": "Controlling playback…"
    case "seek": "Moving to that point…"
    case "skip": "Skipping…"
    case "set_tracks": "Changing subtitles or audio…"
    case "history": "Checking what you watched…"
    case "get_status": "Checking what is playing…"
    default: "Working on it…"
    }
  }

  /// Tools that change what plays: the Ask screen gives way to the picture.
  public static let plays: Set<String> = ["play", "skip", "seek", "control", "transfer"]
}

public struct AgentAvailability: Sendable, Equatable {
  public let available: Bool
  public let title: String?
  public let reason: String?
}

public struct AgentConversation: Sendable, Equatable, Identifiable {
  public struct Message: Sendable, Equatable, Identifiable {
    public let id: String
    /// `user` or `agent`.
    public let role: String
    public let text: String
    /// `done`, `error`, `stopped`, or nil while unanswered.
    public let status: String?
  }

  public let id: String
  public let title: String
  public let updatedAt: Date?
  public let messages: [Message]

  init?(json: JSONValue) {
    guard let id = json["id"]?.string else { return nil }
    self.id = id
    title = json["title"]?.string ?? ""
    updatedAt = json["updatedAt"]?.number.map { Date(timeIntervalSince1970: $0 / 1000) }
    messages = (json["messages"]?.array ?? []).compactMap { message in
      guard let id = message["id"]?.string, let role = message["role"]?.string else { return nil }
      return Message(id: id, role: role, text: message["text"]?.string ?? "", status: message["status"]?.string)
    }
  }
}

extension APIClient {
  /// Whether an agent answers from this screen, and its name.
  public func agent() async throws -> AgentAvailability {
    let answer = try await request("/v1/agent")
    return AgentAvailability(available: answer["available"]?.bool ?? false, title: answer["title"]?.string, reason: answer["reason"]?.string)
  }

  /// The owner's conversations, newest first.
  public func conversations(limit: Int = 30) async throws -> [AgentConversation] {
    try await request("/v1/agent/conversations?limit=\(limit)")["conversations"]?.array?.compactMap(AgentConversation.init(json:)) ?? []
  }

  public func conversation(_ id: String) async throws -> AgentConversation? {
    AgentConversation(json: try await request("/v1/agent/conversations/\(Self.segment(id))"))
  }

  /// Asks in a conversation (`nil` starts one). Cancel the task to stop the
  /// answer: closing the connection stops the agent. One request runs at a
  /// time on the node; a new one from any screen supersedes it.
  public func ask(_ text: String, in conversation: String?, language: String?) async throws -> AsyncThrowingStream<AgentEvent, Error> {
    var request = URLRequest(url: address.url("/v1/agent/conversations/\(Self.segment(conversation ?? "new"))/messages"), timeoutInterval: 240)
    request.httpMethod = "POST"
    request.setValue(String(ClientProtocol.version), forHTTPHeaderField: ClientProtocol.header)
    request.setValue("Bearer \(credential.token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    var body: [String: JSONValue] = ["text": .string(text)]
    if let language { body["language"] = .string(String(language.prefix(35))) }
    request.httpBody = JSONValue.object(body).encoded()
    let (lines, response) = try await transport.lines(for: request)
    guard (200..<300).contains(response.statusCode) else {
      var text = ""
      for try await line in lines { text += line }
      throw YoloAPIError.from(status: response.statusCode, body: try? JSONValue.parse(text), label: "Ask")
    }
    return AsyncThrowingStream { continuation in
      let task = Task {
        do {
          for try await line in lines where !line.trimmingCharacters(in: .whitespaces).isEmpty {
            if let event = AgentEvent(line: line) { continuation.yield(event) }
          }
          continuation.finish()
        } catch {
          continuation.finish(throwing: error)
        }
      }
      continuation.onTermination = { _ in task.cancel() }
    }
  }
}

extension HTTPTransport {
  /// The response's lines as they come. Transports that cannot stream give
  /// the whole body's lines at once.
  public func lines(for request: URLRequest) async throws -> (AsyncThrowingStream<String, Error>, HTTPURLResponse) {
    let (data, response) = try await data(for: request)
    let lines = String(decoding: data, as: UTF8.self).split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    return (AsyncThrowingStream { continuation in
      lines.forEach { continuation.yield($0) }
      continuation.finish()
    }, response)
  }
}

extension URLSessionTransport {
  public func lines(for request: URLRequest) async throws -> (AsyncThrowingStream<String, Error>, HTTPURLResponse) {
    let (bytes, response) = try await session.bytes(for: request)
    guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
    return (AsyncThrowingStream { continuation in
      let task = Task {
        do {
          for try await line in bytes.lines { continuation.yield(line) }
          continuation.finish()
        } catch {
          continuation.finish(throwing: error)
        }
      }
      continuation.onTermination = { _ in task.cancel() }
    }, http)
  }
}
