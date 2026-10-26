import Foundation
import Observation
import SwiftUI
import YoloKit

/// Ask: a request to the owner's agent, said with the Siri Remote's
/// dictation or typed, in a conversation Yolo keeps for every screen
/// (Agent Notes 2026-10-18-agent-from-the-screen and
/// 2026-10-18-multi-agent-conversations). As the player's `ask.js`, the
/// screen shows the current step and the final sentence, never the agent's
/// words along the way.
@MainActor @Observable
final class AskModel {
  struct Entry: Identifiable, Equatable {
    enum Kind { case question, busy, done, error, stopped }
    let id: String
    var kind: Kind
    var text: String
  }

  private(set) var availability: AgentAvailability?
  private(set) var conversationId: String?
  private(set) var title: String?
  private(set) var entries: [Entry] = []
  private(set) var history: [AgentConversation] = []
  private(set) var running = false

  @ObservationIgnored private let api: APIClient
  @ObservationIgnored private var answer: Task<Void, Never>?
  /// Discards a conversation that loads after the owner moved on.
  @ObservationIgnored private var generation = 0
  /// The last conversation and when, reopened within six hours.
  private static let rememberKey = "yolo.ask.conversation"
  private static let remember: TimeInterval = 6 * 3600

  init(api: APIClient) {
    self.api = api
  }

  /// Whether an agent answers, and its name; a failure leaves it as it was.
  func refresh() async {
    if let availability = try? await api.agent() { self.availability = availability }
  }

  var label: String { availability?.title.map { "Ask \($0)" } ?? "Ask" }

  /// Reopens the conversation of the last six hours, if there is one.
  func reopen() async {
    guard conversationId == nil, entries.isEmpty,
          let stored = UserDefaults.standard.dictionary(forKey: Self.rememberKey),
          let id = stored["id"] as? String, let at = stored["at"] as? Double,
          Date().timeIntervalSince1970 - at < Self.remember
    else { return }
    await open(id)
  }

  private func rememberConversation() {
    guard let conversationId else { return }
    UserDefaults.standard.set(["id": conversationId, "at": Date().timeIntervalSince1970], forKey: Self.rememberKey)
  }

  func newConversation() {
    generation += 1
    conversationId = nil
    title = nil
    entries = []
  }

  func open(_ id: String) async {
    generation += 1
    let current = generation
    guard let conversation = try? await api.conversation(id) else {
      UserDefaults.standard.removeObject(forKey: Self.rememberKey)
      return
    }
    guard current == generation, !running || conversationId != id else { return }
    conversationId = conversation.id
    title = conversation.title
    entries = conversation.messages.map { message in
      if message.role == "user" { return Entry(id: message.id, kind: .question, text: message.text) }
      switch message.status {
      case "done": return Entry(id: message.id, kind: .done, text: message.text)
      case "error": return Entry(id: message.id, kind: .error, text: message.text)
      case "stopped": return Entry(id: message.id, kind: .stopped, text: message.text.isEmpty ? "Stopped." : message.text)
      default: return Entry(id: message.id, kind: .stopped, text: message.text.isEmpty ? "No answer yet." : message.text)
      }
    }
    rememberConversation()
  }

  func loadHistory() async {
    history = (try? await api.conversations()) ?? history
  }

  /// Asks. A new question stops the one running; nothing is retried, since
  /// each request spends the owner's own model plan.
  func send(_ text: String) {
    let question = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !question.isEmpty else { return }
    answer?.cancel()
    let answerId = UUID().uuidString
    entries.append(Entry(id: UUID().uuidString, kind: .question, text: String(question.prefix(1000))))
    entries.append(Entry(id: answerId, kind: .busy, text: "Asking…"))
    running = true
    let conversation = conversationId
    answer = Task {
      var ended = false
      do {
        for try await event in try await api.ask(String(question.prefix(1000)), in: conversation, language: Locale.preferredLanguages.first) {
          switch event {
          case .conversation(let id, let title):
            conversationId = id
            if self.title == nil { self.title = title }
            rememberConversation()
          case .tool(let name): update(answerId, .busy, AgentEvent.step(for: name))
          case .text: break
          case .done(let text):
            ended = true
            update(answerId, .done, text.isEmpty ? "Done." : text)
          case .error(let message):
            ended = true
            update(answerId, .error, message)
          }
        }
        if !ended { update(answerId, .error, "The agent stopped without an answer.") }
      } catch is CancellationError {
        update(answerId, .stopped, "Stopped.")
      } catch let error as URLError where error.code == .cancelled {
        update(answerId, .stopped, "Stopped.")
      } catch let error as YoloAPIError {
        update(answerId, .error, error.message)
      } catch {
        update(answerId, .error, "Yolo could not reach the agent.")
      }
      running = false
      rememberConversation()
    }
  }

  /// Stops the answer: closing the connection stops the agent.
  func stop() {
    answer?.cancel()
  }

  private func update(_ id: String, _ kind: Entry.Kind, _ text: String) {
    guard let index = entries.firstIndex(where: { $0.id == id }) else { return }
    entries[index].kind = kind
    entries[index].text = text
  }
}
