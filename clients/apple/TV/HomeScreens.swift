import SwiftUI
import YoloKit

/// The paired app: Home, Search, and Settings along the top, as tvOS apps
/// are laid out, browsed with the Siri Remote's focus.
struct MainTabs: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    TabView {
      Tab("Home", systemImage: "house") { HomeScreen() }
      Tab("Search", systemImage: "magnifyingglass") { SearchScreen() }
      if model.ask?.availability?.available != false {
        Tab(model.ask?.label ?? "Ask", systemImage: "sparkles") { AskScreen() }
      }
      Tab("Settings", systemImage: "gear") { SettingsScreen() }
    }
    .overlay {
      if let title = model.starting {
        StartingOverlay(title: title)
      }
    }
    .alert("Cannot play", isPresented: Binding(get: { model.playError != nil }, set: { if !$0 { model.playError = nil } })) {
      Button("OK", role: .cancel) {}
    } message: {
      Text(model.playError ?? "")
    }
  }
}

struct HomeScreen: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    NavigationStack {
      ScrollView {
        if let browser = model.browser {
          LazyVStack(alignment: .leading, spacing: 56) {
            if let error = browser.error {
              Text(error).foregroundStyle(.secondary)
            }
            if !model.continueCandidates.isEmpty {
              SessionShelf(title: model.continueTitle, sessions: model.continueCandidates)
            }
            if !browser.history.isEmpty {
              Shelf(title: "Continue Watching", items: browser.history, landscape: true)
            }
            if !browser.videos.isEmpty {
              Shelf(title: "Videos", items: browser.videos, landscape: true)
            }
            if !browser.movies.isEmpty {
              Shelf(title: "Movies", items: browser.movies, landscape: false)
            }
            if !browser.shows.isEmpty {
              Shelf(title: "Shows", items: browser.shows, landscape: false)
            }
            if browser.loaded && browser.history.isEmpty && browser.videos.isEmpty && browser.movies.isEmpty && browser.shows.isEmpty && browser.error == nil {
              Text("Nothing here yet. Play something from Search, or ask your agent.")
                .foregroundStyle(.secondary)
            }
            if !browser.loaded {
              ProgressView().frame(maxWidth: .infinity)
            }
          }
          .padding(.vertical, 40)
        }
      }
      .navigationDestination(for: MediaItem.self) { show in EpisodesScreen(show: show) }
    }
    .task { await model.browser?.load() }
    .onChange(of: model.player.isPresented) { _, shown in
      if !shown { Task { await model.browser?.load() } }
    }
  }
}

/// One titled row of cards that scrolls sideways under focus.
struct Shelf: View {
  let title: String
  let items: [MediaItem]
  let landscape: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      Text(title).font(.title3.bold()).padding(.horizontal, 80)
      ScrollView(.horizontal) {
        LazyHStack(alignment: .top, spacing: 48) {
          ForEach(items) { item in
            ItemCard(item: item, landscape: landscape)
          }
        }
        .padding(.horizontal, 80)
        .padding(.vertical, 24)
      }
      .scrollClipDisabled()
    }
  }
}

/// A card: its picture with the progress and watched marks, then its title
/// and one line about it. A show opens its episodes; anything else plays
/// here.
struct ItemCard: View {
  @Environment(AppModel.self) private var model
  let item: MediaItem
  let landscape: Bool

  private var size: CGSize { landscape ? CGSize(width: 400, height: 225) : CGSize(width: 250, height: 375) }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      if item.opens {
        NavigationLink(value: item) { picture }.buttonStyle(.card)
      } else {
        Button { model.play(item) } label: { picture }.buttonStyle(.card)
      }
      Text(item.episodeTitle ?? item.title).font(.callout).lineLimit(1)
      Text(meta).font(.caption).foregroundStyle(.secondary).lineLimit(1)
    }
    .frame(width: size.width)
  }

  private var picture: some View {
    ArtworkView(thumbnail: item.thumbnail, landscape: landscape)
      .frame(width: size.width, height: size.height)
      .overlay(alignment: .bottom) {
        if item.progress > 0 {
          GeometryReader { proxy in
            Capsule().fill(.white).frame(width: proxy.size.width * item.progress, height: 6)
          }
          .frame(height: 6)
          .padding(12)
        }
      }
      .overlay(alignment: .topTrailing) {
        if item.watched {
          Image(systemName: "checkmark.circle.fill").font(.title3).foregroundStyle(.white, .black.opacity(0.5)).padding(10)
        }
      }
  }

  private var meta: String {
    switch item.kind {
    case .show:
      return item.episodes.map { "\($0) episodes" } ?? "Series"
    case .episode:
      let number = [item.season.map { "S\($0)" }, item.episode.map { "E\($0)" }].compactMap { $0 }.joined(separator: " · ")
      return [number.isEmpty ? nil : number, runtime].compactMap { $0 }.joined(separator: " · ")
    default:
      return [item.year.map(String.init), runtime].compactMap { $0 }.joined(separator: " · ")
    }
  }

  private var runtime: String? {
    guard let duration = item.duration, duration > 0 else { return nil }
    let minutes = Int(duration / 60)
    return minutes >= 60 ? "\(minutes / 60) h \(minutes % 60) min" : "\(max(1, minutes)) min"
  }
}

/// "Continue from another screen", the first row of Home (Agent Note
/// 2026-10-31-screen-sessions): other screens' sessions, one press
/// continuing one here with its whole context while that screen pauses.
struct SessionShelf: View {
  @Environment(AppModel.self) private var model
  let title: String
  let sessions: [ScreenSession]

  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      Text(title).font(.title3.bold()).padding(.horizontal, 80)
      ScrollView(.horizontal) {
        LazyHStack(alignment: .top, spacing: 48) {
          ForEach(sessions) { session in
            VStack(alignment: .leading, spacing: 12) {
              Button { model.continueHere(session) } label: {
                ArtworkView(thumbnail: session.thumbnail, landscape: true)
                  .frame(width: 400, height: 225)
                  .overlay(alignment: .bottom) {
                    if let duration = session.duration, duration > 0, !session.isLive {
                      GeometryReader { proxy in
                        Capsule().fill(.white).frame(width: proxy.size.width * min(1, session.livePosition() / duration), height: 6)
                      }
                      .frame(height: 6)
                      .padding(12)
                    }
                  }
              }
              .buttonStyle(.card)
              .accessibilityLabel("Continue \(session.title ?? "Playing") here")
              Text(session.title ?? "Playing").font(.callout).lineLimit(1)
              Text(model.sessionLine(session)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            .frame(width: 400)
          }
        }
        .padding(.horizontal, 80)
        .padding(.vertical, 24)
      }
      .scrollClipDisabled()
    }
  }
}

struct ArtworkView: View {
  @Environment(AppModel.self) private var model
  let thumbnail: String?
  let landscape: Bool
  @State private var image: UIImage?

  var body: some View {
    ZStack {
      Rectangle().fill(.white.opacity(0.08))
      if let image {
        Image(uiImage: image).resizable().scaledToFill()
      } else {
        Image(systemName: "film").font(.largeTitle).foregroundStyle(.tertiary)
      }
    }
    .clipped()
    .task(id: thumbnail) {
      image = await model.artwork?.image(for: thumbnail, landscape: landscape)
    }
  }
}

/// A show's episodes, season by season.
struct EpisodesScreen: View {
  @Environment(AppModel.self) private var model
  let show: MediaItem
  @State private var title: String?
  @State private var seasons: [Season] = []
  @State private var error: String?
  @State private var loaded = false

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 40) {
        Text(title ?? show.title).font(.largeTitle.bold()).padding(.horizontal, 80)
        if let error {
          Text(error).foregroundStyle(.secondary).padding(.horizontal, 80)
        } else if !loaded {
          ProgressView().frame(maxWidth: .infinity)
        }
        ForEach(seasons) { season in
          Shelf(title: "Season \(season.number)", items: season.episodes, landscape: true)
        }
      }
      .padding(.vertical, 40)
    }
    .task {
      guard let browser = model.browser else { return }
      do {
        let (parent, items) = try await browser.api.children(of: show)
        title = parent
        seasons = Season.group(items)
      } catch where !Browser.cancelled(error) {
        self.error = Browser.describe(error).replacingOccurrences(of: "your library", with: "the episodes")
      } catch {
        return
      }
      loaded = true
    }
  }
}

/// Search the owner's libraries; a link plays as it is.
struct SearchScreen: View {
  @Environment(AppModel.self) private var model
  @State private var text = ""
  @State private var results: [MediaItem] = []
  @State private var message: String?

  private let columns = [GridItem(.adaptive(minimum: 250), spacing: 48, alignment: .top)]

  var body: some View {
    NavigationStack {
      ScrollView {
        if let message {
          Text(message).foregroundStyle(.secondary).padding(80)
        }
        if let link = link {
          Button("Play link") { model.play(url: link) }.padding(80)
        }
        LazyVGrid(columns: columns, spacing: 56) {
          ForEach(results) { item in
            ItemCard(item: item, landscape: false)
          }
        }
        .padding(80)
      }
      .searchable(text: $text, prompt: "Movies, shows, or a video link")
      .navigationDestination(for: MediaItem.self) { show in EpisodesScreen(show: show) }
    }
    .task(id: text) {
      let query = text.trimmingCharacters(in: .whitespaces)
      guard !query.isEmpty, link == nil, let browser = model.browser else {
        results = []
        message = nil
        return
      }
      try? await Task.sleep(for: .milliseconds(300))
      guard !Task.isCancelled else { return }
      do {
        results = try await browser.api.search(query)
        message = results.isEmpty ? "Nothing in your libraries matches “\(query)”." : nil
      } catch where !Browser.cancelled(error) {
        message = Browser.describe(error).replacingOccurrences(of: "Cannot load your library", with: "Search failed")
      } catch {
        // The next keystroke cancelled this search.
      }
    }
  }

  private var link: String? {
    let trimmed = text.trimmingCharacters(in: .whitespaces)
    return trimmed.range(of: #"^https?://\S+$"#, options: .regularExpression) != nil ? trimmed : nil
  }
}

/// Shown from the press until the stream's `load` arrives: resolving a
/// source can take a while.
struct StartingOverlay: View {
  let title: String

  var body: some View {
    ZStack {
      Color.black.opacity(0.7).ignoresSafeArea()
      VStack(spacing: 32) {
        ProgressView()
        Text("Starting \(title)…").font(.title3)
      }
    }
  }
}
