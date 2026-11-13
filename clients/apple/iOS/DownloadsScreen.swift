import AVKit
import SwiftUI
import YoloKit

/// The Downloads tab: what this device keeps, playable without a network
/// (Agent Note 2026-11-11-offline-downloads).
struct DownloadsScreen: View {
  @Environment(Downloads.self) private var downloads

  var body: some View {
    NavigationStack {
      Group {
        if downloads.entries.isEmpty {
          ContentUnavailableView(t("No Downloads"), systemImage: "arrow.down.circle")
        } else {
          List {
            ForEach(downloads.entries) { entry in
              DownloadRow(entry: entry) {
                if entry.state == .done {
                  Task { await OfflinePlayback.play(entry, downloads: downloads) }
                } else if entry.state == .failed {
                  downloads.retry(entry.id)
                }
              }
              .swipeActions {
                Button(role: .destructive) { downloads.remove(entry.id) } label: { Label("Delete", systemImage: "trash") }
              }
              .contextMenu {
                if let subtitles = entry.subtitles, !subtitles.isEmpty {
                  Picker(selection: Binding(get: { entry.subtitle }, set: { downloads.choose(subtitle: $0, of: entry.id) })) {
                    Text("Off").tag(String?.none)
                    ForEach(subtitles) { Text(verbatim: $0.label).tag(Optional($0.id)) }
                  } label: {
                    Label("Subtitles", systemImage: "captions.bubble")
                  }
                  .pickerStyle(.menu)
                }
                Button(role: .destructive) { downloads.remove(entry.id) } label: { Label("Delete", systemImage: "trash") }
              }
            }
          }
          .listStyle(.plain)
        }
      }
      .navigationTitle(t("Downloads"))
    }
  }
}

private struct DownloadRow: View {
  @Environment(Downloads.self) private var downloads
  let entry: Downloads.Entry
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 12) {
        cover
          .frame(width: 112, height: 63)
          .clipShape(RoundedRectangle(cornerRadius: 6))
        VStack(alignment: .leading, spacing: 4) {
          Text(entry.title).font(.headline).lineLimit(2)
          if let episode = entry.episode {
            Text(episode).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
          }
          status
        }
        Spacer(minLength: 0)
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }

  @ViewBuilder private var cover: some View {
    if let file = downloads.cover(of: entry), let image = UIImage(contentsOfFile: file.path) {
      Image(uiImage: image).resizable().scaledToFill()
    } else {
      Rectangle().fill(.white.opacity(0.08)).overlay { Image(systemName: "film").foregroundStyle(.tertiary) }
    }
  }

  @ViewBuilder private var status: some View {
    switch entry.state {
    case .queued:
      Text("Waiting").font(.footnote).foregroundStyle(.secondary)
    case .copying:
      ProgressView(value: entry.progress).tint(.white)
    case .failed:
      Label(entry.message ?? t("Stopped. Tap to try again."), systemImage: "exclamationmark.circle")
        .font(.footnote).foregroundStyle(.secondary)
    case .done:
      HStack(spacing: 8) {
        if let duration = entry.duration, duration > 0 {
          Text(Duration.seconds(duration).formatted(.units(allowed: [.hours, .minutes], width: .abbreviated)))
        }
        if let bytes = entry.bytes {
          Text(ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file))
        }
        if let duration = entry.duration, duration > 0, entry.position > 30 {
          ProgressView(value: min(1, entry.position / duration)).tint(.white).frame(width: 60)
        }
      }
      .font(.footnote).foregroundStyle(.secondary)
    }
  }
}

/// A Download button beside Play: tap to keep the item here, at the best
/// quality this device plays or as a smaller file.
struct DownloadButton: View {
  @Environment(Downloads.self) private var downloads
  @Environment(AppModel.self) private var model
  let item: MediaItem
  /// The list the item is in (a season, a video's parts or playlist), from
  /// the item on, when it has more than the item.
  @State private var list: [MediaItem] = []

  var body: some View {
    let entry = downloads.entry(for: item)
    Menu {
      if entry == nil {
        Button { downloads.download(item, size: .best) } label: { Label("Best Quality", systemImage: "sparkles.tv") }
        Button { downloads.download(item, size: .smaller) } label: { Label("Smaller File", systemImage: "arrow.down.right.and.arrow.up.left") }
      }
      if list.count > 1 {
        Menu {
          Button { downloads.download(list, size: .best) } label: { Label("Best Quality", systemImage: "sparkles.tv") }
          Button { downloads.download(list, size: .smaller) } label: { Label("Smaller File", systemImage: "arrow.down.right.and.arrow.up.left") }
        } label: {
          Label("Download All \(list.count)", systemImage: "square.stack.3d.down.right")
        }
      }
      if let entry {
        if entry.state == .failed {
          Button { downloads.retry(entry.id) } label: { Label("Try Again", systemImage: "arrow.clockwise") }
        }
        Button(role: .destructive) { downloads.remove(entry.id) } label: { Label("Delete Download", systemImage: "trash") }
      }
    } label: {
      icon(entry)
        .font(.title3)
        .foregroundStyle(.white)
        .frame(width: 50, height: 50)
        .background(Circle().fill(.white.opacity(0.15)))
    }
    .accessibilityLabel(Text("Download"))
    .task(id: item.id) {
      guard let api = model.browser?.api, let run = try? await api.sequence(of: item) else { return }
      var seen = Set<String>()
      list = ([item] + run.items).filter { !$0.isLive && seen.insert(Downloads.key(of: $0)).inserted }
    }
  }

  @ViewBuilder private func icon(_ entry: Downloads.Entry?) -> some View {
    switch entry?.state {
    case nil: Image(systemName: "arrow.down")
    case .queued: Image(systemName: "clock")
    case .copying:
      ProgressView(value: entry?.progress ?? 0).progressViewStyle(.circular).tint(.white)
        .overlay { Image(systemName: "stop.fill").font(.system(size: 8)) }
    case .failed: Image(systemName: "exclamationmark.arrow.circlepath")
    case .done: Image(systemName: "checkmark")
    }
  }
}

/// Plays a download with the system's player, presented over the app,
/// from where it was left.
@MainActor
enum OfflinePlayback {
  static func play(_ entry: Downloads.Entry, downloads: Downloads) async {
    guard let url = await downloads.playURL(entry),
          let root = (UIApplication.shared.connectedScenes.first as? UIWindowScene)?.keyWindow?.rootViewController
    else { return }
    try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
    try? AVAudioSession.sharedInstance().setActive(true)
    let player = AVPlayer(url: url)
    if entry.position > 5, let duration = entry.duration, entry.position < duration - 10 {
      await player.seek(to: CMTime(seconds: entry.position, preferredTimescale: 600))
    }
    let controller = OfflinePlayerController()
    controller.player = player
    controller.allowsPictureInPicturePlayback = true
    controller.modalPresentationStyle = .fullScreen
    controller.save = { position in downloads.remember(position: position, of: entry.id) }
    controller.cues = downloads.cues(of: entry)
    var top = root
    while let next = top.presentedViewController { top = next }
    Orientation.opening()
    top.present(controller, animated: true) { player.play() }
  }
}

final class OfflinePlayerController: AVPlayerViewController {
  var save: ((Double) -> Void)?
  /// The subtitle shown over the picture.
  var cues: [Cue] = []
  private let caption = UILabel()
  private var captionObserver: Any?
  private var observer: Any?
  private var ended: NSObjectProtocol?

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    guard observer == nil, let player else { return }
    showCaptions(player)
    observer = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 5, preferredTimescale: 1), queue: .main) { [weak self] time in
      MainActor.assumeIsolated { if time.seconds.isFinite { self?.save?(time.seconds) } }
    }
    ended = NotificationCenter.default.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: player.currentItem, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated {
        self?.save?(0)
        self?.dismiss(animated: true)
      }
    }
  }

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    guard isBeingDismissed || presentingViewController == nil else { return }
    if let player {
      let at = player.currentTime().seconds
      if at.isFinite, at > 0, player.currentItem.map({ at < $0.duration.seconds - 1 }) ?? true { save?(at) }
      player.pause()
      if let observer { player.removeTimeObserver(observer) }
      if let captionObserver { player.removeTimeObserver(captionObserver) }
    }
    captionObserver = nil
    observer = nil
    if let ended { NotificationCenter.default.removeObserver(ended) }
    ended = nil
    Orientation.closed()
  }

  private func showCaptions(_ player: AVPlayer) {
    guard !cues.isEmpty, let overlay = contentOverlayView else { return }
    caption.numberOfLines = 0
    caption.textAlignment = .center
    caption.textColor = .white
    caption.font = .preferredFont(forTextStyle: traitCollection.horizontalSizeClass == .regular ? .title2 : .title3)
    caption.adjustsFontForContentSizeCategory = true
    caption.shadowColor = .black
    caption.shadowOffset = CGSize(width: 1, height: 1)
    caption.layer.shadowColor = UIColor.black.cgColor
    caption.layer.shadowRadius = 3
    caption.layer.shadowOpacity = 0.9
    caption.layer.shadowOffset = .zero
    caption.translatesAutoresizingMaskIntoConstraints = false
    overlay.addSubview(caption)
    NSLayoutConstraint.activate([
      caption.leadingAnchor.constraint(greaterThanOrEqualTo: overlay.safeAreaLayoutGuide.leadingAnchor, constant: 24),
      caption.trailingAnchor.constraint(lessThanOrEqualTo: overlay.safeAreaLayoutGuide.trailingAnchor, constant: -24),
      caption.centerXAnchor.constraint(equalTo: overlay.centerXAnchor),
      caption.bottomAnchor.constraint(equalTo: overlay.safeAreaLayoutGuide.bottomAnchor, constant: -28),
    ])
    let cues = cues
    captionObserver = player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 4), queue: .main) { [weak self] time in
      MainActor.assumeIsolated {
        let at = time.seconds
        let text = cues.filter { $0.start <= at && at < $0.end }.map(\.text).joined(separator: "\n")
        if self?.caption.text != text { self?.caption.text = text }
      }
    }
  }
}
