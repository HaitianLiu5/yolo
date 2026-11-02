import Foundation

/// What a screen draws of the agent canvas, declared in `hello`'s
/// capabilities (Agent Note 2026-10-21-agent-canvas). The shape mirrors
/// `service/core/src/canvas.js`; a screen that declares none gets no canvas.
public struct CanvasCapability: Sendable, Equatable, Codable {
  public var surfaces: [String]
  public var kinds: [String: Int]

  public init(surfaces: [String], kinds: [String: Int]) {
    self.surfaces = surfaces
    self.kinds = kinds
  }

  /// The light kinds of step one, drawn over Home and over the player.
  public static let lightKinds = CanvasCapability(surfaces: ["panel", "player"], kinds: ["note": 1, "image": 1, "choices": 1])
}

/// What the person did to an object, sent to `POST /v1/canvas/events`.
public enum CanvasGesture: String, Sendable {
  case press, pick, dismiss
}

/// One thing an agent placed on this screen, as the Hub keeps it:
/// `{ id, surface, kind, layout, props, actions, fallback, scope, transient,
/// expiresAt, createdAt }`.
public struct CanvasObject: Sendable, Equatable, Identifiable {
  public let id: String
  public let surface: String
  public let kind: String
  public let anchor: String
  public let z: Int
  public let props: JSONValue
  /// Gesture to the action it does, such as `press: notify`.
  public let actions: [String: String]
  public let fallbackTitle: String?
  public let fallbackText: String?
  public let scope: String
  public let transient: Bool
  public let expiresAt: Date?
  public let createdAt: Date?

  public init?(json: JSONValue) {
    guard let id = json["id"]?.string, let kind = json["kind"]?.string else { return nil }
    self.id = id
    self.kind = kind
    surface = json["surface"]?.string ?? "panel"
    anchor = json["layout"]?["anchor"]?.string ?? "center"
    z = json["layout"]?["z"]?.int ?? 0
    props = json["props"] ?? [:]
    actions = (json["actions"]?.object ?? [:]).compactMapValues { $0["do"]?.string }
    fallbackTitle = json["fallback"]?["title"]?.string
    fallbackText = json["fallback"]?["text"]?.string
    scope = json["scope"]?.string ?? "device"
    transient = json["transient"]?.bool ?? false
    expiresAt = json["expiresAt"]?.number.map { Date(timeIntervalSince1970: $0 / 1000) }
    createdAt = json["createdAt"]?.number.map { Date(timeIntervalSince1970: $0 / 1000) }
  }

  /// Whether it is still to be drawn at `now`.
  public func isLive(at now: Date) -> Bool { expiresAt.map { $0 > now } ?? true }

  /// Whether a press on it does something, so the screen offers one.
  public var pressable: Bool { actions["press"] != nil }

  /// What to draw, by kind; a kind this screen does not know shows its
  /// fallback as a card.
  public var content: Content {
    switch kind {
    case "note":
      if let text = props["text"]?.string { return .note(title: props["title"]?.string, text: text) }
    case "image":
      if let url = props["url"]?.string { return .image(url: url, alt: props["alt"]?.string, title: props["title"]?.string) }
    case "choices":
      let options = (props["options"]?.array ?? []).enumerated().compactMap { CanvasChoice(json: $1, index: $0) }
      if !options.isEmpty { return .choices(title: props["title"]?.string, options: options) }
    default:
      break
    }
    return .fallback(title: fallbackTitle, text: fallbackText)
  }

  public enum Content: Sendable, Equatable {
    case note(title: String?, text: String)
    /// An http(s) picture, or a library item's artwork; `Artwork.request`
    /// loads either from Yolo's origin.
    case image(url: String, alt: String?, title: String?)
    case choices(title: String?, options: [CanvasChoice])
    case fallback(title: String?, text: String?)
  }
}

/// One option of a choices object: an item Yolo looked up, or a label that
/// asks the agent for something else, each with at most one line of the
/// agent's own. `index` is what a pick names.
public struct CanvasChoice: Sendable, Equatable, Identifiable {
  public let index: Int
  public let item: Item?
  public let label: String?
  public let note: String?

  public var id: Int { index }

  public struct Item: Sendable, Equatable {
    public let source: JSONValue
    public let title: String?
    public let thumbnail: String?
    public let duration: Double?
  }

  init?(json: JSONValue, index: Int) {
    self.index = index
    note = json["note"]?.string
    if let item = json["item"], let source = item["source"], !source.isNull {
      self.item = Item(source: source, title: item["title"]?.string, thumbnail: item["thumbnail"]?.string, duration: item["duration"]?.number)
      label = nil
    } else if let label = json["label"]?.string {
      item = nil
      self.label = label
    } else {
      return nil
    }
  }
}

/// This screen's canvas: the objects whole from the welcome or
/// `GET /v1/canvas`, then each `canvas_ops { rev, ops }` applied in order.
/// A rev that is not exactly the next means a change went missing, and the
/// screen reads the whole canvas again. Objects the person just acted on are
/// hidden at once, before the Hub's remove arrives.
public struct Canvas: Sendable, Equatable {
  public private(set) var rev = 0
  public private(set) var objects: [CanvasObject] = []
  private var settled: Set<String> = []

  public enum Step: Sendable, Equatable {
    case applied
    /// Read the canvas again with `APIClient.canvas()` and `replace` it.
    case reread
  }

  public init() {}

  /// A welcome's `canvas` or `GET /v1/canvas`'s answer; none (a Hub before
  /// the canvas) is an empty canvas.
  public init(json: JSONValue?) {
    replace(json)
  }

  public mutating func replace(_ json: JSONValue?) {
    replace(rev: json?["rev"]?.int ?? 0, objects: (json?["objects"]?.array ?? []).compactMap(CanvasObject.init(json:)))
  }

  /// The canvas read again after a gap; what the person acted on stays hidden.
  public mutating func replace(_ fresh: Canvas) {
    replace(rev: fresh.rev, objects: fresh.objects)
  }

  private mutating func replace(rev: Int, objects: [CanvasObject]) {
    self.rev = rev
    self.objects = objects
    settled.formIntersection(objects.map(\.id))
  }

  /// A `canvas_ops` message.
  public mutating func apply(_ message: RealtimeMessage) -> Step {
    guard message.type == "canvas_ops" else { return .applied }
    guard message["rev"]?.int == rev + 1 else { return .reread }
    rev += 1
    for op in message["ops"]?.array ?? [] {
      switch op["op"]?.string {
      case "put":
        guard let object = op["object"].flatMap(CanvasObject.init(json:)) else { continue }
        objects.removeAll { $0.id == object.id }
        objects.append(object)
      case "remove":
        guard let id = op["id"]?.string else { continue }
        objects.removeAll { $0.id == id }
        settled.remove(id)
      default:
        continue
      }
    }
    return .applied
  }

  /// Hides an object the person acted on, until the Hub removes it.
  public mutating func settle(_ id: String) { settled.insert(id) }

  /// The gesture failed: the object shows again.
  public mutating func unsettle(_ id: String) { settled.remove(id) }

  /// What this screen draws at `now`: live objects on the surfaces it
  /// declared, not settled, in the Hub's order.
  public func shown(at now: Date, surfaces: [String] = CanvasCapability.lightKinds.surfaces) -> [CanvasObject] {
    objects.filter { !settled.contains($0.id) && $0.isLive(at: now) && surfaces.contains($0.surface) }
  }

  /// The choices to draw, the newest when there are several.
  public func choices(at now: Date) -> CanvasObject? {
    shown(at: now).last { $0.kind == "choices" }
  }

  /// Everything else, drawn as small cards.
  public func cards(at now: Date) -> [CanvasObject] {
    shown(at: now).filter { $0.kind != "choices" }
  }

  /// When the next live object expires, so the screen redraws then.
  public func nextExpiry(after now: Date) -> Date? {
    objects.compactMap(\.expiresAt).filter { $0 > now }.min()
  }
}

extension APIClient {
  /// This screen's whole canvas (`GET /v1/canvas`).
  public func canvas() async throws -> Canvas {
    Canvas(json: try await request("/v1/canvas"))
  }

  /// What the person did to `objectId`. A pick names the option, with
  /// `after: true` to play it after what plays now; the Hub plays or queues
  /// it and closes the choices.
  public func sendCanvasGesture(_ gesture: CanvasGesture, objectId: String, payload: JSONValue? = nil) async throws {
    try await request("/v1/canvas/events", method: "POST", body: [
      "objectId": .string(objectId), "gesture": .string(gesture.rawValue), "payload": payload ?? .null,
    ])
  }

  /// Picks option `index` of a choices object: play it now, or after this.
  public func pickCanvasChoice(_ index: Int, objectId: String, after: Bool = false) async throws {
    var payload: [String: JSONValue] = ["option": .number(Double(index))]
    if after { payload["after"] = true }
    try await sendCanvasGesture(.pick, objectId: objectId, payload: .object(payload))
  }
}
