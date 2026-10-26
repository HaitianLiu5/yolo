/// What a screen plays, sent in `hello`
/// (Agent Note 2026-10-07-capability-negotiation). The shape mirrors
/// `service/core/src/capabilities.js`.
public struct Capabilities: Sendable, Equatable, Codable {
  public var renderer: String
  public var delivery: [String]
  public var containers: [String]
  /// Preferred first.
  public var video: [String]
  public var audio: [String]
  public var maxHeight: Int
  public var subtitles: String
  public var audioOnly: Bool

  public init(
    renderer: String, delivery: [String], containers: [String], video: [String], audio: [String],
    maxHeight: Int, subtitles: String, audioOnly: Bool = false
  ) {
    self.renderer = renderer
    self.delivery = delivery
    self.containers = containers
    self.video = video
    self.audio = audio
    self.maxHeight = maxHeight
    self.subtitles = subtitles
    self.audioOnly = audioOnly
  }

  /// AVPlayer on Apple TV (Agent Note 2026-10-19-apple-tv-client,
  /// Capabilities): HLS and progressive MP4, `avc1` first and `hvc1` where
  /// the model decodes it, AAC, AC-3 and E-AC-3, and WebVTT the app draws
  /// itself. `maxHeight` is the TV's current display mode.
  public static func appleTV(maxHeight: Int, decodesHEVC: Bool) -> Capabilities {
    Capabilities(
      renderer: "native",
      delivery: ["hls", "mp4"],
      containers: ["mp4"],
      video: decodesHEVC ? ["avc1", "hvc1"] : ["avc1"],
      audio: ["mp4a", "ac-3", "ec-3"],
      maxHeight: maxHeight,
      subtitles: "client-vtt"
    )
  }

  /// AVPlayer on iPhone and iPad (Agent Note 2026-10-23-iphone-and-ipad-client,
  /// Playback): what the Apple TV plays, with `maxHeight` from the screen's
  /// shorter side.
  public static func iPhone(maxHeight: Int, decodesHEVC: Bool) -> Capabilities {
    appleTV(maxHeight: maxHeight, decodesHEVC: decodesHEVC)
  }
}
