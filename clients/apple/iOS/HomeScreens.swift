import SwiftUI
import YoloKit

/// The paired app: Home, Search, and Settings as a tab bar on iPhone and a
/// sidebar on iPad.
struct MainTabs: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    TabView {
      Tab("Home", systemImage: "house") { HomeScreen() }
      Tab("Search", systemImage: "magnifyingglass") { SearchScreen() }
      Tab("Settings", systemImage: "gear") { SettingsScreen() }
    }
    .tabViewStyle(.sidebarAdaptable)
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

/// Card sizes: larger in a regular width (iPad, or an iPhone sideways in
/// the larger models).
struct CardSize {
  let regular: Bool

  func of(landscape: Bool) -> CGSize {
    switch (landscape, regular) {
    case (true, true): CGSize(width: 320, height: 180)
    case (true, false): CGSize(width: 240, height: 135)
    case (false, true): CGSize(width: 180, height: 270)
    case (false, false): CGSize(width: 120, height: 180)
    }
  }
}

struct HomeScreen: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    NavigationStack {
      ScrollView {
        if let browser = model.browser {
          LazyVStack(alignment: .leading, spacing: 28) {
            if let error = browser.error {
              Text(error).foregroundStyle(.secondary).padding(.horizontal)
            }
            if !browser.history.isEmpty {
              Shelf(title: "Continue Watching", items: browser.history, landscape: true)
            }
            if !browser.movies.isEmpty {
              Shelf(title: "Movies", items: browser.movies, landscape: false)
            }
            if !browser.shows.isEmpty {
              Shelf(title: "Shows", items: browser.shows, landscape: false)
            }
            if browser.loaded && browser.history.isEmpty && browser.movies.isEmpty && browser.shows.isEmpty && browser.error == nil {
              Text("Nothing here yet. Play something from Search, or ask your agent.")
                .foregroundStyle(.secondary).padding(.horizontal)
            }
            if !browser.loaded {
              ProgressView().frame(maxWidth: .infinity)
            }
          }
          .padding(.vertical)
        }
      }
      .refreshable { await model.browser?.load() }
      .navigationTitle("Home")
      .navigationDestination(for: MediaItem.self) { show in EpisodesScreen(show: show) }
    }
    .task { await model.browser?.load() }
    .onChange(of: model.player.isPresented) { _, shown in
      if !shown { Task { await model.browser?.load() } }
    }
  }
}

/// One titled row of cards that scrolls sideways.
struct Shelf: View {
  let title: String
  let items: [MediaItem]
  let landscape: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(title).font(.title3.bold()).padding(.horizontal)
      ScrollView(.horizontal, showsIndicators: false) {
        LazyHStack(alignment: .top, spacing: 14) {
          ForEach(items) { item in
            ItemCard(item: item, landscape: landscape)
          }
        }
        .padding(.horizontal)
      }
    }
  }
}

/// A card: its picture with the progress and watched marks Yolo records,
/// then its title and one line about it. A show opens its episodes;
/// anything else plays here.
struct ItemCard: View {
  @Environment(AppModel.self) private var model
  @Environment(\.horizontalSizeClass) private var sizeClass
  let item: MediaItem
  let landscape: Bool
  /// In a grid the card takes the column's width.
  var fill = false

  private var size: CGSize { CardSize(regular: sizeClass == .regular).of(landscape: landscape) }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if item.opens {
        NavigationLink(value: item) { picture }.buttonStyle(.plain)
      } else {
        Button { model.play(item) } label: { picture }.buttonStyle(.plain)
      }
      Text(item.episodeTitle ?? item.title).font(.subheadline).lineLimit(1)
      Text(meta).font(.caption).foregroundStyle(.secondary).lineLimit(1)
    }
    .frame(width: fill ? nil : size.width)
  }

  private var picture: some View {
    ArtworkView(thumbnail: item.thumbnail, landscape: landscape)
      .aspectRatio(size.width / size.height, contentMode: .fit)
      .frame(width: fill ? nil : size.width)
      .clipShape(RoundedRectangle(cornerRadius: 10))
      .overlay(alignment: .bottom) {
        if item.progress > 0 {
          GeometryReader { proxy in
            Capsule().fill(.white).frame(width: proxy.size.width * item.progress, height: 4)
          }
          .frame(height: 4)
          .padding(8)
        }
      }
      .overlay(alignment: .topTrailing) {
        if item.watched {
          Image(systemName: "checkmark.circle.fill").foregroundStyle(.white, .black.opacity(0.5)).padding(6)
        }
      }
      .contentShape(Rectangle())
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

struct ArtworkView: View {
  @Environment(AppModel.self) private var model
  let thumbnail: String?
  let landscape: Bool
  @State private var image: UIImage?

  var body: some View {
    Rectangle().fill(.white.opacity(0.08))
      .overlay {
        if let image {
          Image(uiImage: image).resizable().scaledToFill()
        } else {
          Image(systemName: "film").font(.title).foregroundStyle(.tertiary)
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
      LazyVStack(alignment: .leading, spacing: 28) {
        if let error {
          Text(error).foregroundStyle(.secondary).padding(.horizontal)
        } else if !loaded {
          ProgressView().frame(maxWidth: .infinity)
        }
        ForEach(seasons) { season in
          Shelf(title: "Season \(season.number)", items: season.episodes, landscape: true)
        }
      }
      .padding(.vertical)
    }
    .navigationTitle(title ?? show.title)
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
  @Environment(\.horizontalSizeClass) private var sizeClass
  @State private var text = ""
  @State private var results: [MediaItem] = []
  @State private var message: String?

  private var columns: [GridItem] {
    [GridItem(.adaptive(minimum: CardSize(regular: sizeClass == .regular).of(landscape: false).width), spacing: 14, alignment: .top)]
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        if let message {
          Text(message).foregroundStyle(.secondary).padding()
        }
        if let link {
          Button("Play link") { model.play(url: link) }.buttonStyle(.borderedProminent).padding()
        }
        LazyVGrid(columns: columns, spacing: 20) {
          ForEach(results) { item in
            ItemCard(item: item, landscape: false, fill: true)
          }
        }
        .padding()
      }
      .navigationTitle("Search")
      .searchable(text: $text, prompt: "Movies, shows, or a video link")
      .textInputAutocapitalization(.never)
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

/// Shown from the tap until the stream's `load` arrives: resolving a source
/// can take a while.
struct StartingOverlay: View {
  let title: String

  var body: some View {
    ZStack {
      Color.black.opacity(0.6).ignoresSafeArea()
      VStack(spacing: 16) {
        ProgressView()
        Text("Starting \(title)…").font(.headline).multilineTextAlignment(.center)
      }
      .padding()
    }
  }
}
