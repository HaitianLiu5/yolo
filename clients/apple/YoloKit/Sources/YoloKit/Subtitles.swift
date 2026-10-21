import Foundation

/// A stream's tracks as a `load` or a `tracks` message gives them
/// (Agent Note 2026-10-07-capability-negotiation): text subtitles are
/// WebVTT the screen draws itself; an image subtitle is burned into the
/// picture by the source, and choosing one is a new stream.
public struct StreamTracks: Sendable, Equatable {
  public struct Subtitle: Sendable, Equatable {
    public let id: String
    public let name: String?
    public let language: String?
    /// The WebVTT URL, for a track delivered as `vtt`.
    public let url: String?
    public let delivery: String?
    /// A track the source or the node is still making, read again for a
    /// window around the position.
    public var growing: Bool = false

    /// Shown by the screen, switched without a new stream.
    public var inPlace: Bool { delivery == "vtt" && url != nil }
  }

  public var subtitles: [Subtitle]
  /// The ids of the subtitles on screen.
  public var selected: [String]

  public static let none = StreamTracks(subtitles: [], selected: [])

  public init(subtitles: [Subtitle], selected: [String]) {
    self.subtitles = subtitles
    self.selected = selected
  }

  public init(json: JSONValue?, selected: JSONValue? = nil) {
    subtitles = (json?["subtitles"]?.array ?? []).compactMap { track in
      guard let id = track["id"]?.string else { return nil }
      return Subtitle(
        id: id, name: track["name"]?.string, language: track["language"]?.string, url: track["url"]?.string,
        delivery: track["delivery"]?.string, growing: track["growing"]?.bool ?? false
      )
    }
    let chosen = selected ?? json?["selected"]
    self.selected = chosen?["subtitles"]?.array?.compactMap(\.string) ?? []
  }

  /// A `tracks` message: new tracks, the selection, or both.
  public func applying(tracks: JSONValue?, selected: JSONValue?) -> StreamTracks {
    if let tracks, !tracks.isNull { return StreamTracks(json: tracks, selected: selected) }
    var next = self
    if let ids = selected?["subtitles"]?.array { next.selected = ids.compactMap(\.string) }
    return next
  }

  public func subtitle(_ id: String) -> Subtitle? { subtitles.first { $0.id == id } }

  /// The subtitles Yolo chose for the stream on screen (a welcome's
  /// `state.tracks`), when they are not the ones the screen shows and a
  /// `tracks` message would have switched them in place, as the player's
  /// `subtitlesToFollow`. Nil otherwise; a switch to or from a burned-in
  /// track is a new stream.
  public func toFollow(_ state: JSONValue?, deviceId: String?, sessionId: String?) -> [String]? {
    guard let state, let deviceId, let sessionId, state["deviceId"]?.string == deviceId, state["sessionId"]?.string == sessionId,
          let wanted = state["tracks"]?["subtitles"]?.array?.compactMap(\.string)
    else { return nil }
    if Set(wanted) == Set(selected) && wanted.count == selected.count { return nil }
    let inPlace = { (id: String) in self.subtitle(id)?.inPlace == true }
    return wanted.allSatisfy(inPlace) && selected.allSatisfy(inPlace) ? wanted : nil
  }
}

/// One WebVTT cue, in seconds of the item.
public struct Cue: Sendable, Equatable {
  public let start: Double
  public let end: Double
  public let text: String
}

public enum WebVTT {
  /// The cues of a WebVTT file, tags removed, in order of their start.
  public static func parse(_ text: String) -> [Cue] {
    var cues: [Cue] = []
    let blocks = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n\n")
    for block in blocks {
      let lines = block.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
      guard let timing = lines.firstIndex(where: { $0.contains("-->") }) else { continue }
      let parts = lines[timing].components(separatedBy: "-->")
      guard parts.count == 2, let start = seconds(parts[0]), let end = seconds(parts[1].split(separator: " ").first.map(String.init) ?? "") else { continue }
      let body = lines[(timing + 1)...].joined(separator: "\n")
        .replacingOccurrences(of: #"<[^>]+>"#, with: "", options: .regularExpression)
        .replacingOccurrences(of: "&amp;", with: "&").replacingOccurrences(of: "&lt;", with: "<").replacingOccurrences(of: "&gt;", with: ">")
        .trimmingCharacters(in: .whitespacesAndNewlines)
      if !body.isEmpty { cues.append(Cue(start: start, end: end, text: body)) }
    }
    return cues.sorted { $0.start < $1.start }
  }

  /// `hh:mm:ss.ttt` or `mm:ss.ttt`.
  static func seconds(_ text: String) -> Double? {
    let fields = text.trimmingCharacters(in: .whitespaces).split(separator: ":").map(String.init)
    guard (2...3).contains(fields.count) else { return nil }
    var total = 0.0
    for field in fields {
      guard let value = Double(field.replacingOccurrences(of: ",", with: ".")) else { return nil }
      total = total * 60 + value
    }
    return total
  }

  /// The text of the cues showing at `time`, joined line by line.
  public static func text(at time: Double, in cues: [Cue]) -> String? {
    let showing = cues.filter { $0.start <= time && time < $0.end }.map(\.text)
    return showing.isEmpty ? nil : showing.joined(separator: "\n")
  }
}

/// Growing subtitle tracks (Agent Note 2026-10-18-ai-subtitles), as the
/// player's `growing-subtitles.js` reads them: again every few seconds, for
/// a window around the position that reaches well ahead, since the window
/// tells the node what to work on next.
public enum GrowingSubtitles {
  public static let poll: Duration = .seconds(4)
  public static let behind = 10.0
  public static let ahead = 90.0
  /// A seek further than this asks at once rather than at the next poll.
  public static let jump = 20.0

  /// The window to ask for at item time `time`.
  public static func window(at time: Double) -> ClosedRange<Double> {
    let at = max(0, time)
    return max(0, at - behind)...(at + ahead)
  }

  /// The track's URL asking for `window`.
  public static func url(_ base: URL, window: ClosedRange<Double>) -> URL {
    var components = URLComponents(url: base, resolvingAgainstBaseURL: true)!
    var items = (components.queryItems ?? []).filter { $0.name != "start" && $0.name != "end" }
    items.append(URLQueryItem(name: "start", value: String(format: "%.1f", window.lowerBound)))
    items.append(URLQueryItem(name: "end", value: String(format: "%.1f", window.upperBound)))
    components.queryItems = items
    return components.url!
  }

  /// The track's cues after an answer for `window`: the fresh cues replace
  /// every cue the answer covers (the window, widened to the fresh cues'
  /// span), and the rest stay.
  public static func merge(_ cues: [Cue], fresh: [Cue], window: ClosedRange<Double>) -> [Cue] {
    let start = min(window.lowerBound, fresh.map(\.start).min() ?? window.lowerBound)
    let end = max(window.upperBound, fresh.map(\.end).max() ?? window.upperBound)
    let kept = cues.filter { $0.end <= start || $0.start >= end }
    return (kept + fresh).sorted { $0.start < $1.start }
  }
}
