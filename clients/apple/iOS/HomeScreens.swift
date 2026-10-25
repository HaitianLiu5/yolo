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

/// How many cards a row shows across the screen, the last one peeking in so
/// the row reads as one that scrolls: posters about 3.7 across an iPhone and
/// 7 across an iPad, landscape cards about 1.3 and 3.
struct CardsAcross {
  let count: Int
  let span: Int

  static func of(landscape: Bool, regular: Bool) -> CardsAcross {
    switch (landscape, regular) {
    case (true, false): CardsAcross(count: 4, span: 3)
    case (true, true): CardsAcross(count: 3, span: 1)
    case (false, false): CardsAcross(count: 15, span: 4)
    case (false, true): CardsAcross(count: 7, span: 1)
    }
  }

  static let spacing: CGFloat = 12
  static let margin: CGFloat = 16
}

struct HomeScreen: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    NavigationStack {
      ScrollView {
        if let browser = model.browser {
          LazyVStack(alignment: .leading, spacing: 24) {
            if let error = browser.error {
              Text(error).foregroundStyle(.secondary).padding(.horizontal, CardsAcross.margin)
            }
            // What was playing leads, under the title, as the largest cards.
            if !browser.history.isEmpty {
              Shelf(items: browser.history, landscape: true)
            }
            if !browser.movies.isEmpty {
              Shelf(title: "Movies", items: browser.movies, landscape: false, all: .movies)
            }
            if !browser.shows.isEmpty {
              Shelf(title: "Shows", items: browser.shows, landscape: false, all: .shows)
            }
            if browser.loaded && browser.history.isEmpty && browser.movies.isEmpty && browser.shows.isEmpty && browser.error == nil {
              Text("Nothing here yet. Play something from Search, or ask your agent.")
                .foregroundStyle(.secondary).padding(.horizontal, CardsAcross.margin)
            }
            if !browser.loaded {
              ProgressView().frame(maxWidth: .infinity)
            }
          }
          .padding(.bottom)
        }
      }
      .refreshable { await model.browser?.load() }
      .navigationTitle("Home")
      .navigationDestination(for: MediaItem.self) { item in ItemScreen(item: item) }
      .navigationDestination(for: LibraryGrid.Kind.self) { kind in LibraryGrid(kind: kind) }
    }
    .task { await model.browser?.load() }
    .onChange(of: model.player.isPresented) { _, shown in
      if !shown { Task { await model.browser?.load() } }
    }
  }
}

/// One row of cards that scrolls sideways and stops on a card, with its
/// title and, when it has more than a row shows, See All.
struct Shelf: View {
  @Environment(\.horizontalSizeClass) private var sizeClass
  var title: String?
  let items: [MediaItem]
  let landscape: Bool
  var all: LibraryGrid.Kind?

  /// Enough cards for a row; See All shows the rest.
  private static let shown = 20

  var body: some View {
    let across = CardsAcross.of(landscape: landscape, regular: sizeClass == .regular)
    VStack(alignment: .leading, spacing: 8) {
      if let title {
        HStack(alignment: .firstTextBaseline) {
          Text(title).font(.title2.bold())
          Spacer()
          if let all, items.count > Self.shown || items.count > across.count / across.span {
            NavigationLink("See All", value: all).font(.body)
          }
        }
        .padding(.horizontal, CardsAcross.margin)
      }
      ScrollView(.horizontal, showsIndicators: false) {
        LazyHStack(alignment: .top, spacing: CardsAcross.spacing) {
          ForEach(items.prefix(Self.shown)) { item in
            ItemCard(item: item, landscape: landscape)
              .containerRelativeFrame(.horizontal, count: across.count, span: across.span, spacing: CardsAcross.spacing)
          }
        }
        .scrollTargetLayout()
      }
      .contentMargins(.horizontal, CardsAcross.margin, for: .scrollContent)
      .scrollTargetBehavior(.viewAligned)
    }
  }
}

/// A card: its picture with the progress and watched marks Yolo records,
/// then its title and one line about it, as wide as its row or grid makes
/// it. The cover opens a show's episodes or anything else's details; the
/// play button plays it here.
struct ItemCard: View {
  @Environment(AppModel.self) private var model
  let item: MediaItem
  let landscape: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      // The cover opens the item; its play button plays it.
      NavigationLink(value: item) { picture }
        .buttonStyle(.plain)
        .overlay(alignment: landscape ? .center : .bottomTrailing) {
          if !item.opens {
            Button { model.play(item) } label: {
              Image(systemName: "play.fill")
                .font(landscape ? .title2 : .footnote)
                .foregroundStyle(.white)
                .frame(width: landscape ? 52 : 30, height: landscape ? 52 : 30)
                .background(.black.opacity(0.45), in: Circle())
                .overlay { Circle().strokeBorder(.white.opacity(0.8), lineWidth: landscape ? 2 : 1) }
            }
            .buttonStyle(.plain)
            .padding(landscape ? 0 : 6)
            .accessibilityLabel("Play \(item.episodeTitle ?? item.title)")
          }
        }
      VStack(alignment: .leading, spacing: 1) {
        Text(item.episodeTitle ?? item.title).font(.subheadline).lineLimit(1)
        Text(meta).font(.caption).foregroundStyle(.secondary).lineLimit(1)
      }
    }
  }

  private var picture: some View {
    Color.clear
      .aspectRatio(landscape ? 16 / 9 : 2 / 3, contentMode: .fit)
      .overlay { ArtworkView(thumbnail: item.thumbnail, landscape: landscape) }
      .clipShape(RoundedRectangle(cornerRadius: landscape ? 12 : 8))
      .overlay(alignment: .bottomLeading) {
        if item.progress > 0 {
          GeometryReader { proxy in
            ZStack(alignment: .leading) {
              Capsule().fill(.white.opacity(0.3))
              Capsule().fill(.white).frame(width: proxy.size.width * item.progress)
            }
          }
          .frame(height: 3)
          .padding(.horizontal, 8)
          .padding(.bottom, 6)
        }
      }
      .overlay(alignment: .topTrailing) {
        if item.watched {
          Image(systemName: "checkmark.circle.fill").font(.footnote).foregroundStyle(.white, .black.opacity(0.5)).padding(5)
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
      // A poster's line is narrow: its year alone, as a library shows it.
      return (landscape ? [item.year.map(String.init), runtime] : [item.year.map(String.init)]).compactMap { $0 }.joined(separator: " · ")
    }
  }

  private var runtime: String? {
    guard let duration = item.duration, duration > 0 else { return nil }
    let minutes = Int(duration / 60)
    return minutes >= 60 ? "\(minutes / 60) h \(minutes % 60) min" : "\(max(1, minutes)) min"
  }
}

/// Posters in a grid as wide as the screen: three or more across an
/// iPhone, more on an iPad.
struct PosterGrid: View {
  @Environment(\.horizontalSizeClass) private var sizeClass
  let items: [MediaItem]

  var body: some View {
    let minimum: CGFloat = sizeClass == .regular ? 140 : 100
    LazyVGrid(columns: [GridItem(.adaptive(minimum: minimum), spacing: CardsAcross.spacing, alignment: .top)], spacing: 16) {
      ForEach(items) { item in
        ItemCard(item: item, landscape: false)
      }
    }
    .padding(.horizontal, CardsAcross.margin)
  }
}

/// Every movie or every show, from a row's See All.
struct LibraryGrid: View {
  enum Kind: Hashable { case movies, shows }

  @Environment(AppModel.self) private var model
  let kind: Kind

  var body: some View {
    ScrollView {
      PosterGrid(items: kind == .movies ? model.browser?.movies ?? [] : model.browser?.shows ?? [])
        .padding(.vertical)
    }
    .navigationTitle(kind == .movies ? "Movies" : "Shows")
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
      LazyVStack(alignment: .leading, spacing: 24) {
        if let error {
          Text(error).foregroundStyle(.secondary).padding(.horizontal, CardsAcross.margin)
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
  @State private var text = ""
  @State private var results: [MediaItem] = []
  @State private var message: String?

  var body: some View {
    NavigationStack {
      ScrollView {
        if let message {
          Text(message).foregroundStyle(.secondary).padding()
        }
        if let link {
          Button("Play link") { model.play(url: link) }.buttonStyle(.borderedProminent).padding()
        }
        PosterGrid(items: results).padding(.vertical)
      }
      .navigationTitle("Search")
      .searchable(text: $text, prompt: "Movies, shows, or a video link")
      .textInputAutocapitalization(.never)
      .navigationDestination(for: MediaItem.self) { item in ItemScreen(item: item) }
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

/// Where a cover goes: a show's episodes, else the item's details.
struct ItemScreen: View {
  let item: MediaItem

  var body: some View {
    if item.opens { EpisodesScreen(show: item) } else { DetailScreen(item: item) }
  }
}
