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
        Tab(model.ask?.label ?? t("Ask"), systemImage: "sparkles") { AskScreen() }
      }
      Tab("Settings", systemImage: "gear") { SettingsScreen() }
    }
    // Home is still while the agent's choices take the screen, and while a
    // press starts, which Back then leaves.
    .disabled(model.starting != nil || !model.player.isPresented && model.canvas.choices(at: model.canvasNow) != nil)
    .overlay {
      if !model.player.isPresented {
        CanvasLayer(playing: false)
      }
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
  @State private var path = NavigationPath()

  var body: some View {
    NavigationStack(path: $path) {
      ScrollView {
        if let browser = model.browser {
          LazyVStack(alignment: .leading, spacing: 56) {
            if let error = browser.error {
              Text(error).foregroundStyle(.secondary)
            }
            if !model.continueCandidates.isEmpty {
              SessionShelf(title: model.continueTitle, sessions: model.continueCandidates)
            }
            // What is on now comes before what was playing, as on the
            // player's home (Agent Note 2026-11-04-living-home-and-media-pool).
            FeedShelf(title: Text("Live now"), items: browser.feed.row("live"))
            let history = model.notOffered(browser.history)
            if !history.isEmpty {
              Shelf(title: Text("Continue Watching"), items: history, landscape: true)
            }
            let videos = model.notOffered(browser.videos)
            if !videos.isEmpty {
              Shelf(title: Text("Videos"), items: videos, landscape: true)
            }
            FeedShelf(title: Text("New for you"), items: browser.feed.row("new"))
            FeedShelf(title: Text("Replays"), items: browser.feed.row("replays"))
            ForEach(browser.events) { row in
              Shelf(title: Text(row.library.title), items: row.items, landscape: true)
            }
            if !browser.movies.isEmpty {
              Shelf(title: Text("Movies"), items: browser.movies, landscape: false)
            }
            if !browser.shows.isEmpty {
              Shelf(title: Text("Shows"), items: browser.shows, landscape: false)
            }
            if browser.loaded && browser.feed.rows.isEmpty && browser.history.isEmpty && browser.videos.isEmpty && browser.events.isEmpty && browser.movies.isEmpty && browser.shows.isEmpty && browser.error == nil {
              Text("Nothing here yet")
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
    .environment(\.openVersions) { path.append($0) }
    .task { await model.browser?.load() }
    // The rows Yolo fills by itself are asked for again while Home shows.
    .task { await model.browser?.keepFeedFresh() }
    .onChange(of: model.player.isPresented) { _, shown in
      if !shown { Task { await model.browser?.load() } }
    }
  }
}

extension EnvironmentValues {
  /// Opens a game's versions in the navigation stack around the card.
  @Entry var openVersions: @MainActor (MediaItem) -> Void = { _ in }
}

/// One titled row of cards that scrolls sideways under focus.
struct Shelf: View {
  /// A literal is looked up; a library's name from Yolo shows as it is.
  let title: Text
  let items: [MediaItem]
  let landscape: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      title.font(.title3.bold()).padding(.horizontal, 80)
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
/// here, and a long press on a game offers its versions.
struct ItemCard: View {
  @Environment(AppModel.self) private var model
  @Environment(\.openVersions) private var openVersions
  let item: MediaItem
  let landscape: Bool

  private var size: CGSize { landscape ? CGSize(width: 400, height: 225) : CGSize(width: 250, height: 375) }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      if item.opens {
        NavigationLink(value: item) { picture }.buttonStyle(.card)
      } else {
        Button { model.play(item) } label: { picture }
          .buttonStyle(.card)
          .contextMenu {
            if item.hasVersions {
              Button("All Versions") { openVersions(item) }
            }
          }
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
      return item.episodes.map { t("\($0) episodes") } ?? t("Series")
    case .episode:
      let number = [item.season.map { t("S\($0)") }, item.episode.map { t("E\($0)") }].compactMap { $0 }.joined(separator: " · ")
      return [number.isEmpty ? nil : number, runtime].compactMap { $0 }.joined(separator: " · ")
    case .event:
      return item.eventLine ?? (item.isLive ? t("Live") : runtime ?? "")
    default:
      return [item.year.map(String.init), runtime].compactMap { $0 }.joined(separator: " · ")
    }
  }

  private var runtime: String? {
    guard let duration = item.duration, duration > 0 else { return nil }
    let minutes = Int(duration / 60)
    return minutes >= 60 ? t("\(minutes / 60) h \(minutes % 60) min") : t("\(max(1, minutes)) min")
  }
}

/// A row Yolo fills by itself; nothing when it has no cards.
struct FeedShelf: View {
  @Environment(AppModel.self) private var model
  let title: Text
  let items: [FeedItem]
  @State private var notice: String?

  var body: some View {
    if !items.isEmpty {
      VStack(alignment: .leading, spacing: 20) {
        title.font(.title3.bold()).padding(.horizontal, 80)
        ScrollView(.horizontal) {
          LazyHStack(alignment: .top, spacing: 48) {
            ForEach(items) { item in
              FeedCard(item: item) { notice = $0 }
            }
          }
          .padding(.horizontal, 80)
          .padding(.vertical, 24)
        }
        .scrollClipDisabled()
      }
      .alert(notice ?? "", isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) {
        Button("OK", role: .cancel) {}
      }
    }
  }
}

/// A card of those rows: a press plays it, or says when a game that has not
/// started starts; a long press offers Not Interested and Stop Following.
struct FeedCard: View {
  @Environment(AppModel.self) private var model
  let item: FeedItem
  let say: (String) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Button(action: press) { picture }
        .buttonStyle(.card)
        .contextMenu {
          Button("Not Interested") { model.browser?.notInterested(item) }
          if let why = item.why, let interest = why.interest {
            Button("Stop Following \(why.title)") { model.browser?.stopFollowing(interest) }
          }
        }
      Text(item.item.title).font(.callout).lineLimit(1)
      Text(item.line).font(.caption).foregroundStyle(.secondary).lineLimit(1)
    }
    .frame(width: 400)
  }

  private func press() {
    if item.isUpcoming {
      say(t("\(item.item.title) starts \(item.live?.startsAt.map(FeedItem.startsAt) ?? t("Soon"))"))
    } else {
      model.play(item.item)
    }
  }

  private var picture: some View {
    Group {
      if let matchup = item.matchup {
        MatchupView(matchup: matchup, live: item.isLive)
      } else {
        ArtworkView(thumbnail: item.item.thumbnail, landscape: true)
      }
    }
    .frame(width: 400, height: 225)
    .overlay(alignment: .topLeading) {
      if let badge = item.badgeText {
        Text(badge)
          .font(.caption2.bold())
          .padding(.horizontal, 10).padding(.vertical, 4)
          .background(item.isLive ? Color.red : Color.black.opacity(0.6), in: Capsule())
          .foregroundStyle(.white)
          .padding(12)
      }
    }
    .overlay(alignment: .bottom) {
      if item.item.progress > 0 {
        GeometryReader { proxy in
          Capsule().fill(.white).frame(width: proxy.size.width * item.item.progress, height: 6)
        }
        .frame(height: 6)
        .padding(12)
      }
    }
  }
}

/// A game's picture: its two sides' badges and names, and the score while
/// it is on (Agent Note 2026-11-04-living-home-and-media-pool).
struct MatchupView: View {
  let matchup: FeedItem.Matchup
  let live: Bool

  var body: some View {
    ZStack {
      Rectangle().fill(.white.opacity(0.08))
      HStack(spacing: 16) {
        side(matchup.left)
        Text(verbatim: live ? matchup.score : "vs").font(.title3.bold().monospacedDigit()).lineLimit(1).fixedSize()
        side(matchup.right)
      }
      .padding(.horizontal, 16)
    }
  }

  private func side(_ side: FeedItem.Matchup.Side) -> some View {
    VStack(spacing: 8) {
      ArtworkView(thumbnail: side.badge, landscape: false)
        .frame(width: 88, height: 88)
        .clipShape(Circle())
      Text(side.name).font(.caption).lineLimit(1)
    }
    .frame(maxWidth: .infinity)
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
              .accessibilityLabel("Continue \(session.title ?? t("Playing")) here")
              Text(session.title ?? t("Playing")).font(.callout).lineLimit(1)
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
          // A game's versions are choices of one thing, not a season's run.
          Shelf(title: Text(show.hasVersions ? "Versions" : "Season \(season.number)"), items: season.episodes, landscape: true)
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
        self.error = Browser.describe(error, loading: .episodes)
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
  @State private var path = NavigationPath()
  @State private var text = ""
  @State private var results: [MediaItem] = []
  @State private var message: String?

  private let columns = [GridItem(.adaptive(minimum: 250), spacing: 48, alignment: .top)]

  var body: some View {
    NavigationStack(path: $path) {
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
      .searchable(text: $text, prompt: t("Movies, shows, or a video link"))
      .navigationDestination(for: MediaItem.self) { show in EpisodesScreen(show: show) }
    }
    .environment(\.openVersions) { path.append($0) }
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
        message = results.isEmpty ? t("Nothing in your libraries matches “\(query)”.") : nil
      } catch where !Browser.cancelled(error) {
        message = Browser.describe(error, loading: .search)
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
  @Environment(AppModel.self) private var model
  let title: String
  @FocusState private var focused: Bool

  var body: some View {
    ZStack {
      Color.black.opacity(0.7).ignoresSafeArea()
      VStack(spacing: 32) {
        ProgressView()
        Text("Starting \(title)…").font(.title3)
      }
    }
    // It takes the focus, so Back on the remote leaves the start as it
    // leaves the player: the stream is left if it still comes.
    .focusable()
    .focused($focused)
    .defaultFocus($focused, true)
    .onAppear { focused = true }
    .onExitCommand { model.leftPlayer() }
  }
}
