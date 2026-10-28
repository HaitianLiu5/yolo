import Foundation
import Testing
@testable import YoloKit

@Suite struct CanvasTests {
  static let now = Date(timeIntervalSince1970: 1_800_000_000)
  static let millis = 1_800_000_000_000.0

  static func object(_ id: String, kind: String, props: JSONValue, surface: String = "panel", expiresAt: Double? = nil) -> JSONValue {
    [
      "id": .string(id), "surface": .string(surface), "kind": .string(kind),
      "layout": ["anchor": "center", "w": "auto", "h": "auto", "z": 0], "props": props, "actions": [:],
      "fallback": ["title": "Choices", "text": "Heat · Ronin"], "owner": "agent", "scope": "device",
      "transient": .bool(kind == "choices"), "expiresAt": expiresAt.map { .number($0) } ?? .null, "createdAt": .number(millis - 1000),
    ]
  }

  static let choices = object("obj_choices1", kind: "choices", props: [
    "title": "Tonight?",
    "options": [
      ["item": ["source": ["plugin": "plex", "id": "1"], "title": "Heat", "thumbnail": "/v1/library/items/plex%3A1/artwork", "duration": 10_200], "note": "The diner scene"],
      ["label": "Something lighter", "note": nil],
    ],
  ], expiresAt: millis + 600_000)

  static func ops(_ rev: Int, _ ops: [JSONValue]) -> RealtimeMessage {
    RealtimeMessage(text: JSONValue.object(["v": 1, "type": "canvas_ops", "rev": .number(Double(rev)), "ops": .array(ops)]).encodedString())!
  }

  @Test func helloDeclaresTheLightKindsOverHomeAndThePlayer() throws {
    let hello = try JSONValue.parse(Hello(name: "TV", capabilities: .appleTV(maxHeight: 1080, decodesHEVC: false)).encoded())
    #expect(hello["capabilities"]?["canvas"]?["surfaces"] == ["panel", "player"])
    #expect(hello["capabilities"]?["canvas"]?["kinds"] == ["note": 1, "image": 1, "choices": 1])
    // A host without a canvas sends none.
    let plain = Capabilities(renderer: "native", delivery: ["hls"], containers: ["mp4"], video: ["avc1"], audio: ["mp4a"], maxHeight: 1080, subtitles: "client-vtt")
    #expect(try JSONValue.parse(Hello(name: "TV", capabilities: plain).encoded())["capabilities"]?["canvas"] == nil)
  }

  @Test func theWelcomeGivesTheWholeCanvasAndChoicesReadTheirOptions() throws {
    let message = RealtimeMessage(text: JSONValue.object(["v": 1, "type": "welcome", "canvas": ["rev": 4, "objects": [Self.choices]]]).encodedString())!
    let canvas = Canvas(json: Welcome(message)?.canvas)
    #expect(canvas.rev == 4)
    let object = try #require(canvas.choices(at: Self.now))
    guard case .choices(let title, let options) = object.content else { Issue.record("not choices"); return }
    #expect(title == "Tonight?")
    #expect(options.map(\.index) == [0, 1])
    #expect(options[0].item?.source == ["plugin": "plex", "id": "1"])
    #expect(options[0].item?.duration == 10_200)
    #expect(options[0].note == "The diner scene")
    #expect(options[1].item == nil && options[1].label == "Something lighter")
    #expect(object.transient && object.expiresAt == Date(timeIntervalSince1970: 1_800_000_600))
    // A Hub before the canvas sends none: an empty canvas at rev 0.
    #expect(Canvas(json: nil) == Canvas())
  }

  @Test func opsApplyInOrderAndAGapAsksToReadItAgain() throws {
    var canvas = Canvas(json: ["rev": 1, "objects": [Self.choices]])
    let note = Self.object("obj_note1", kind: "note", props: ["title": "Cast", "text": "Al Pacino, Robert De Niro"])
    #expect(canvas.apply(Self.ops(2, [["op": "put", "object": note]])) == .applied)
    #expect(canvas.cards(at: Self.now).map(\.content) == [.note(title: "Cast", text: "Al Pacino, Robert De Niro")])
    // A put of the same id replaces it.
    let changed = Self.object("obj_note1", kind: "note", props: ["text": "Val Kilmer"])
    #expect(canvas.apply(Self.ops(3, [["op": "put", "object": changed], ["op": "remove", "id": "obj_choices1"]])) == .applied)
    #expect(canvas.objects.map(\.id) == ["obj_note1"])
    #expect(canvas.cards(at: Self.now).first?.content == .note(title: nil, text: "Val Kilmer"))
    #expect(canvas.choices(at: Self.now) == nil)
    // Rev 5 after 3: rev 4 went missing, so nothing applies until it is read again.
    #expect(canvas.apply(Self.ops(5, [["op": "remove", "id": "obj_note1"]])) == .reread)
    #expect(canvas.rev == 3 && canvas.objects.count == 1)
    // An old rev is a gap too.
    #expect(canvas.apply(Self.ops(3, [])) == .reread)
  }

  @Test func aGapReadsTheWholeCanvasFromYolo() async throws {
    let transport = StubTransport { request in
      #expect(request.url?.path == "/v1/canvas")
      #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer ydt_t")
      return (200, ["rev": 9, "objects": [Self.choices]])
    }
    let api = APIClient(address: server, credential: DeviceCredential(token: "ydt_t", deviceId: "tv"), transport: transport)
    var canvas = Canvas(json: ["rev": 2, "objects": []])
    #expect(canvas.apply(Self.ops(7, [])) == .reread)
    canvas.replace(try await api.canvas())
    #expect(canvas.rev == 9)
    #expect(canvas.choices(at: Self.now)?.id == "obj_choices1")
    #expect(canvas.apply(Self.ops(10, [["op": "remove", "id": "obj_choices1"]])) == .applied)
    #expect(canvas.objects.isEmpty)
  }

  @Test func gesturesGoToTheHubAndHideTheObjectAtOnce() async throws {
    let transport = StubTransport { _ in (200, ["event": ["cursor": 1]]) }
    let api = APIClient(address: server, credential: DeviceCredential(token: "ydt_t", deviceId: "tv"), transport: transport)
    try await api.pickCanvasChoice(0, objectId: "obj_choices1")
    try await api.pickCanvasChoice(0, objectId: "obj_choices1", after: true)
    try await api.sendCanvasGesture(.dismiss, objectId: "obj_note1")
    let sent = transport.requests
    #expect(sent.map(\.httpMethod) == ["POST", "POST", "POST"])
    #expect(sent.allSatisfy { $0.url?.path == "/v1/canvas/events" })
    #expect(sent[0].jsonBody == ["objectId": "obj_choices1", "gesture": "pick", "payload": ["option": 0]])
    #expect(sent[1].jsonBody == ["objectId": "obj_choices1", "gesture": "pick", "payload": ["option": 0, "after": true]])
    #expect(sent[2].jsonBody == ["objectId": "obj_note1", "gesture": "dismiss", "payload": nil])

    var canvas = Canvas(json: ["rev": 1, "objects": [Self.choices]])
    canvas.settle("obj_choices1")
    #expect(canvas.choices(at: Self.now) == nil)
    canvas.unsettle("obj_choices1")
    #expect(canvas.choices(at: Self.now) != nil)
    canvas.settle("obj_choices1")
    #expect(canvas.apply(Self.ops(2, [["op": "remove", "id": "obj_choices1"]])) == .applied)
    #expect(canvas.objects.isEmpty)
  }

  @Test func expiredObjectsOtherSurfacesAndUnknownKinds() throws {
    let canvas = Canvas(json: ["rev": 1, "objects": [
      Self.object("obj_old1", kind: "note", props: ["text": "Gone"], expiresAt: Self.millis - 1),
      Self.object("obj_wall1", kind: "note", props: ["text": "Wallpaper"], surface: "wallpaper"),
      Self.object("obj_soon1", kind: "image", props: ["url": "https://example.com/a.jpg", "alt": "A poster"], surface: "player", expiresAt: Self.millis + 5000),
      Self.object("obj_poll1", kind: "poll", props: ["question": "?"]),
    ]])
    let cards = canvas.cards(at: Self.now)
    #expect(cards.map(\.id) == ["obj_soon1", "obj_poll1"])
    #expect(cards[0].content == .image(url: "https://example.com/a.jpg", alt: "A poster", title: nil))
    #expect(cards[1].content == .fallback(title: "Choices", text: "Heat · Ronin"))
    #expect(canvas.nextExpiry(after: Self.now) == Date(timeIntervalSince1970: 1_800_000_005))
    #expect(canvas.cards(at: Self.now.addingTimeInterval(6)).map(\.id) == ["obj_poll1"])
  }
}
