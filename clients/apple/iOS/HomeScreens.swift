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
    .alert("Cannot play", isPresented: Binding(get: { model.playError != nil }, set: { if !$0 { model.playError = nil } })) {
      Button("OK", role: .cancel) {}
    } message: {
      Text(model.playError ?? "")
    }
  }
}

/// How many cards a row shows across the screen, the last one peeking in so
/// the row reads as one that scrolls: posters about 3.7 across an iPhone and
/// 7 across an iPad, landscape cards about 1.3 and 3, and small landscape
/// cards, sized beside the posters, about 2.2 and 5.
struct CardsAcross {
  let count: Int
  let span: Int

  static func of(landscape: Bool, regular: Bool, small: Bool = false) -> CardsAcross {
    if small { return regular ? CardsAcross(count: 5, span: 1) : CardsAcross(count: 9, span: 4) }
    return switch (landscape, regular) {
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
            // Another screen's session comes first: one tap continues it
            // here (Agent Note 2026-10-31-screen-sessions).
            if !model.continueCandidates.isEmpty {
              SessionShelf(title: model.continueTitle, sessions: model.continueCandidates)
            }
            // What was playing leads, as the largest cards, titled like
            // every row below it.
            if !browser.history.isEmpty {
              Shelf(title: "Recent", items: browser.history, landscape: true)
            }
            if !browser.videos.isEmpty {
              Shelf(title: "Videos", items: browser.videos, landscape: true, small: true, all: .videos)
            }
            if !browser.movies.isEmpty {
              Shelf(title: "Movies", items: browser.movies, landscape: false, all: .movies)
            }
            if !browser.shows.isEmpty {
              Shelf(title: "Shows", items: browser.shows, landscape: false, all: .shows)
            }
            if browser.loaded && browser.history.isEmpty && browser.videos.isEmpty && browser.movies.isEmpty && browser.shows.isEmpty && browser.error == nil {
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
      // No title over the rows: the tab bar already says Home, so the first
      // row starts under the status bar.
      .toolbar(.hidden, for: .navigationBar)
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
  @Environment(AppModel.self) private var model
  @Environment(\.horizontalSizeClass) private var sizeClass
  var title: String?
  let items: [MediaItem]
  let landscape: Bool
  /// Landscape cards at about the posters' size, several across.
  var small = false
  var all: LibraryGrid.Kind?

  /// Enough cards for a row; See All shows the rest.
  private static let shown = 20

  var body: some View {
    let across = CardsAcross.of(landscape: landscape, regular: sizeClass == .regular, small: small)
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
            ItemCard(item: item, landscape: landscape, small: small)
              .containerRelativeFrame(.horizontal, count: across.count, span: across.span, spacing: CardsAcross.spacing)
          }
        }
        .scrollTargetLayout()
        // The whole row's covers load at once, not as each card scrolls in.
        .task(id: items.map(\.id)) { await model.artwork?.prefetch(items.prefix(Self.shown).map(\.thumbnail), landscape: landscape) }
      }
      .contentMargins(.horizontal, CardsAcross.margin, for: .scrollContent)
      .scrollTargetBehavior(.viewAligned)
    }
  }
}

/// "Continue from another screen": other screens' sessions as landscape
/// cards, the play button continuing one here with its whole context while
/// that screen pauses.
struct SessionShelf: View {
  @Environment(AppModel.self) private var model
  @Environment(\.horizontalSizeClass) private var sizeClass
  let title: String
  let sessions: [ScreenSession]

  var body: some View {
    let across = CardsAcross.of(landscape: true, regular: sizeClass == .regular)
    VStack(alignment: .leading, spacing: 8) {
      Text(title).font(.title2.bold()).padding(.horizontal, CardsAcross.margin)
      ScrollView(.horizontal, showsIndicators: false) {
        LazyHStack(alignment: .top, spacing: CardsAcross.spacing) {
          ForEach(sessions) { session in
            card(session)
              .containerRelativeFrame(.horizontal, count: across.count, span: across.span, spacing: CardsAcross.spacing)
          }
        }
        .scrollTargetLayout()
      }
      .contentMargins(.horizontal, CardsAcross.margin, for: .scrollContent)
      .scrollTargetBehavior(.viewAligned)
    }
  }

  private func card(_ session: ScreenSession) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Button { model.continueHere(session) } label: {
        Color.clear
          .aspectRatio(16 / 9, contentMode: .fit)
          .overlay { ArtworkView(thumbnail: session.thumbnail, landscape: true) }
          .overlay {
            Image(systemName: "play.fill")
              .font(.title2)
              .foregroundStyle(.white)
              .frame(width: 52, height: 52)
              .background(.black.opacity(0.45), in: Circle())
              .overlay { Circle().strokeBorder(.white.opacity(0.8), lineWidth: 2) }
          }
          .overlay(alignment: .bottomLeading) {
            if let duration = session.duration, duration > 0, !session.isLive {
              GeometryReader { proxy in
                ZStack(alignment: .leading) {
                  Rectangle().fill(.black.opacity(0.4))
                  Rectangle().fill(.white).frame(width: proxy.size.width * min(1, session.livePosition() / duration))
                }
              }
              .frame(height: 3)
            }
          }
          .clipShape(RoundedRectangle(cornerRadius: 12))
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Continue \(session.title ?? "Playing") here")
      VStack(alignment: .leading, spacing: 1) {
        Text(session.title ?? "Playing").font(.subheadline).lineLimit(1)
        Text(model.sessionLine(session)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
      }
    }
  }
}

/// A card: its picture with the progress Yolo records, then its title, a
/// dot beside it when it was never played, and one line about it, as wide as its row or grid makes
/// it. The cover opens a show's episodes or anything else's details; the
/// play button plays it here.
struct ItemCard: View {
  @Environment(AppModel.self) private var model
  let item: MediaItem
  let landscape: Bool
  /// A small landscape card takes the posters' corner play button.
  var small = false

  /// The big play button centered on a wide card, else the corner one.
  private var big: Bool { landscape && !small }

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      // The cover opens the item; its play button plays it.
      NavigationLink(value: item) { picture }
        .buttonStyle(.plain)
        .overlay(alignment: big ? .center : .bottomTrailing) {
          if !item.opens {
            Button { model.play(item) } label: {
              Image(systemName: "play.fill")
                .font(big ? .title2 : .footnote)
                .foregroundStyle(.white)
                .frame(width: big ? 52 : 30, height: big ? 52 : 30)
                .background(.black.opacity(0.45), in: Circle())
                .overlay { Circle().strokeBorder(.white.opacity(0.8), lineWidth: big ? 2 : 1) }
            }
            .buttonStyle(.plain)
            .padding(big ? 0 : 6)
            .accessibilityLabel("Play \(item.episodeTitle ?? item.title)")
          }
        }
      VStack(alignment: .leading, spacing: 1) {
        // A dot marks what was never played, as Podcasts and TV do; a
        // watched item shows neither the dot nor a progress line.
        HStack(spacing: 5) {
          if item.unplayed {
            Circle().fill(Color.accentColor).frame(width: 7, height: 7).accessibilityLabel("Unplayed")
          }
          Text(item.episodeTitle ?? item.title).font(.subheadline).lineLimit(1)
        }
        Text(meta).font(.caption).foregroundStyle(.secondary).lineLimit(1)
      }
    }
  }

  private var picture: some View {
    Color.clear
      .aspectRatio(landscape ? 16 / 9 : 2 / 3, contentMode: .fit)
      .overlay { ArtworkView(thumbnail: item.thumbnail, landscape: landscape) }
      // The progress runs along the picture's bottom edge, cut by its corners.
      .overlay(alignment: .bottomLeading) {
        if item.shownProgress > 0 {
          GeometryReader { proxy in
            ZStack(alignment: .leading) {
              Rectangle().fill(.black.opacity(0.4))
              Rectangle().fill(.white).frame(width: proxy.size.width * item.shownProgress)
            }
          }
          .frame(height: 3)
        }
      }
      .clipShape(RoundedRectangle(cornerRadius: landscape ? 12 : 8))
      .contentShape(Rectangle())
  }

  private var meta: String {
    // A web video from history: the site it is on and when it last played.
    if let site = item.site {
      let played = item.updatedAt.map { $0.formatted(.relative(presentation: .named, unitsStyle: .abbreviated)) }
      return [site, played].compactMap { $0 }.joined(separator: " · ")
    }
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

/// Every movie or every show, from a row's See All, as Infuse's library
/// page: three posters across an iPhone, a sort chosen at the top, and
/// with titles in order, an A to Z index down the side to jump with.
struct LibraryGrid: View {
  enum Kind: Hashable { case movies, shows, videos }

  /// The orders the page offers; picking the one in use turns it around.
  enum Order: String, CaseIterable {
    case added = "Date Added", title = "Title", year = "Year", unwatched = "Unwatched", random = "Randomly"

    /// Videos come from history, newest played first.
    func name(for kind: Kind) -> String { self == .added && kind == .videos ? "Last Played" : rawValue }
  }

  @Environment(AppModel.self) private var model
  @Environment(\.horizontalSizeClass) private var sizeClass
  let kind: Kind
  @State private var order = Order.added
  @State private var ascending = false
  @State private var shuffled: [String] = []

  private var all: [MediaItem] {
    switch kind {
    case .movies: model.browser?.movies ?? []
    case .shows: model.browser?.shows ?? []
    case .videos: model.browser?.videos ?? []
    }
  }

  private var items: [MediaItem] {
    let items = all
    switch order {
    case .added:
      // The server lists the newest first.
      return ascending ? items.reversed() : items
    case .title:
      let sorted = items.sorted { Self.sortTitle($0).localizedStandardCompare(Self.sortTitle($1)) == .orderedAscending }
      return ascending ? sorted : sorted.reversed()
    case .year:
      let sorted = items.sorted { ($0.year ?? 0) < ($1.year ?? 0) }
      return ascending ? sorted : sorted.reversed()
    case .unwatched:
      // Never played, then started, then watched.
      let rank = { (item: MediaItem) in item.unplayed ? 0 : item.shownProgress > 0 ? 1 : 2 }
      let sorted = items.enumerated().sorted { (rank($0.element), $0.offset) < (rank($1.element), $1.offset) }.map(\.element)
      return ascending ? sorted : sorted.reversed()
    case .random:
      let place = Dictionary(uniqueKeysWithValues: shuffled.enumerated().map { ($1, $0) })
      return items.sorted { (place[$0.id] ?? .max) < (place[$1.id] ?? .max) }
    }
  }

  var body: some View {
    let items = items
    ScrollViewReader { reader in
      ScrollView {
        LazyVGrid(columns: columns, alignment: .leading, spacing: 16) {
          ForEach(items) { item in
            ItemCard(item: item, landscape: kind == .videos, small: true).id(item.id)
          }
        }
        .padding(.horizontal, CardsAcross.margin)
        .padding(.vertical)
      }
      .overlay(alignment: .trailing) {
        if order == .title { LetterIndex(items: items) { reader.scrollTo($0, anchor: .top) } }
      }
    }
    .navigationTitle(kind == .movies ? "Movies" : kind == .shows ? "Shows" : "Videos")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Menu {
          ForEach(Order.allCases.filter { kind != .videos || $0 != .year }, id: \.self) { choice in
            Button {
              if choice == order, choice != .random {
                ascending.toggle()
              } else {
                order = choice
                ascending = choice == .title || choice == .unwatched
                if choice == .random { shuffled = all.map(\.id).shuffled() }
              }
            } label: {
              if choice == order, choice != .random {
                Label(choice.name(for: kind), systemImage: ascending ? "arrow.up" : "arrow.down")
              } else {
                Text(choice.name(for: kind))
              }
            }
          }
        } label: {
          HStack(spacing: 4) {
            Text(order.name(for: kind))
            if order != .random { Image(systemName: ascending ? "arrow.up" : "arrow.down") }
          }
          .foregroundStyle(Color.accentColor)
        }
        .menuOrder(.fixed)
      }
    }
  }

  /// Three posters across an iPhone, or two videos; more on an iPad.
  private var columns: [GridItem] {
    sizeClass == .regular
      ? [GridItem(.adaptive(minimum: kind == .videos ? 220 : 140), spacing: CardsAcross.spacing, alignment: .top)]
      : Array(repeating: GridItem(.flexible(), spacing: CardsAcross.spacing, alignment: .top), count: kind == .videos ? 2 : 3)
  }

  /// The title as it sorts: without leading marks such as 【 or quotes.
  static func sortTitle(_ item: MediaItem) -> String {
    String(item.title.drop { !$0.isLetter && !$0.isNumber })
  }

  /// The index letter a title files under: A to Z, else #.
  static func letter(_ item: MediaItem) -> String {
    guard let first = sortTitle(item).first?.uppercased(), first.count == 1, ("A"..."Z").contains(first) else { return "#" }
    return first
  }
}

/// Letters down the screen's edge; a tap or a drag along them jumps to the
/// first title under the letter.
private struct LetterIndex: View {
  let items: [MediaItem]
  let jump: (String) -> Void

  var body: some View {
    var firsts: [(letter: String, id: String)] = []
    for item in items {
      let letter = LibraryGrid.letter(item)
      if firsts.last?.letter != letter, !firsts.contains(where: { $0.letter == letter }) { firsts.append((letter, item.id)) }
    }
    return GeometryReader { proxy in
      VStack(spacing: 1) {
        ForEach(firsts, id: \.letter) { entry in
          Text(entry.letter).font(.system(size: 11, weight: .semibold)).frame(width: 18, height: 15)
        }
      }
      .foregroundStyle(Color.accentColor)
      .frame(maxHeight: .infinity)
      .contentShape(Rectangle())
      .gesture(DragGesture(minimumDistance: 0).onChanged { value in
        let top = (proxy.size.height - CGFloat(firsts.count) * 16) / 2
        let index = Int((value.location.y - top) / 16)
        if firsts.indices.contains(index) { jump(firsts[index].id) }
      })
    }
    .frame(width: 18)
    .padding(.trailing, 2)
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

/// A show: the episode up next on a detail page, with every season's
/// episodes beneath it to choose from.
struct EpisodesScreen: View {
  @Environment(AppModel.self) private var model
  let show: MediaItem
  @State private var title: String?
  @State private var seasons: [Season] = []
  @State private var chosen: MediaItem?
  @State private var error: String?

  var body: some View {
    Group {
      if let chosen {
        DetailScreen(item: chosen, show: title ?? show.title, seasons: seasons) { self.chosen = $0 }
      } else if let error {
        Text(error).foregroundStyle(.secondary).padding(.horizontal, CardsAcross.margin)
      } else {
        ProgressView()
      }
    }
    .toolbar(.hidden, for: .tabBar)
    .task {
      guard let browser = model.browser else { return }
      do {
        let (parent, items) = try await browser.api.children(of: show)
        title = parent
        seasons = Season.group(items)
        chosen = Self.upNext(items)
      } catch where !Browser.cancelled(error) {
        self.error = Browser.describe(error).replacingOccurrences(of: "your library", with: "the episodes")
      } catch {}
    }
  }

  /// The episode the page opens on: the first started, else the first
  /// never played, else the first.
  static func upNext(_ episodes: [MediaItem]) -> MediaItem? {
    episodes.first { $0.progress > 0 } ?? episodes.first(where: \.unplayed) ?? episodes.first
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
      .searchable(text: $text, placement: .navigationBarDrawer(displayMode: .always), prompt: "Movies, shows, or a video link")
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

/// Where a cover goes: a show's episodes, else the item's details.
struct ItemScreen: View {
  let item: MediaItem

  var body: some View {
    if item.opens { EpisodesScreen(show: item) } else { DetailScreen(item: item) }
  }
}
