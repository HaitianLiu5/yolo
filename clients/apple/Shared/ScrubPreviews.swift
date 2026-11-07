import Observation
import UIKit
import YoloKit

/// Small pictures of a stream's moments, read from the media node while the
/// owner scrubs and kept for the next scrub of the same item
/// (Agent Note 2026-11-07-scrub-previews).
@MainActor @Observable
final class ScrubPreviews {
  /// The stream has previews, so the controls keep room for them.
  private(set) var available = false
  private var images: [Int: UIImage] = [:]

  @ObservationIgnored private var base: URL?
  @ObservationIgnored private var item: String?
  @ObservationIgnored private var schedule: PreviewSchedule?
  /// Moments kept, the oldest first.
  @ObservationIgnored private var order: [Int] = []
  /// Bumped when the item changes: a read of the last item is not kept.
  @ObservationIgnored private var generation = 0

  /// About 500 KB each once decoded.
  private static let kept = 120

  /// A new stream: the same item keeps its pictures, another starts over.
  func load(_ stream: StreamDescriptor, item: JSONValue?, server: ServerAddress) {
    let key = item?["source"].map { $0.encodedString() } ?? stream.sessionId
    if key != self.item {
      self.item = key
      forgetAll()
    }
    base = stream.isLive ? nil : stream.previews.flatMap { stream.resolve($0, server: server) }
    available = base != nil
  }

  func clear() {
    base = nil
    item = nil
    available = false
    forgetAll()
  }

  private func forgetAll() {
    generation += 1
    schedule = nil
    images = [:]
    order = []
  }

  func began() {
    schedule?.began()
  }

  /// The owner is at `position`: reads what it needs.
  func scrub(to position: Double, duration: Double) {
    guard base != nil, duration > 0 else { return }
    if schedule == nil { schedule = PreviewSchedule(duration: duration) }
    start(schedule?.scrubbed(to: position) ?? [])
  }

  func ended() {
    schedule?.ended()
  }

  /// The picture of the moment nearest `position` that has arrived.
  func image(near position: Double) -> UIImage? {
    _ = images.count
    return schedule?.nearest(to: position).flatMap { images[$0] }
  }

  private func start(_ times: [Int]) {
    guard let base else { return }
    let generation = generation
    for time in times {
      Task { [weak self] in
        let answer = await Self.read(PreviewSchedule.url(base, time: time))
        self?.finished(time, answer, of: generation)
      }
    }
  }

  private func finished(_ time: Int, _ answer: (PreviewSchedule.Outcome, UIImage?), of reader: Int) {
    guard reader == generation else { return }
    if let image = answer.1 { keep(image, at: time) }
    start(schedule?.finished(time, answer.0) ?? [])
  }

  private func keep(_ image: UIImage, at time: Int) {
    images[time] = image
    order.removeAll { $0 == time }
    order.append(time)
    while order.count > Self.kept {
      let oldest = order.removeFirst()
      images[oldest] = nil
      schedule?.forget(oldest)
    }
  }

  private nonisolated static func read(_ url: URL) async -> (PreviewSchedule.Outcome, UIImage?) {
    var request = URLRequest(url: url)
    request.timeoutInterval = 15
    guard let (data, response) = try? await URLSession.shared.data(for: request),
          let status = (response as? HTTPURLResponse)?.statusCode
    else { return (.failed, nil) }
    if status == 429 { return (.busy, nil) }
    guard status == 200, let image = await UIImage(data: data)?.byPreparingForDisplay() else { return (.failed, nil) }
    return (.loaded, image)
  }
}
