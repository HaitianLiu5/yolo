import SwiftUI
import YoloKit

/// What a cover opens: the item's picture across the top, what it is, Play
/// or Resume where Yolo says it was left, its description, ratings, the
/// people in it, and what it holds, all from the owner's server
/// (`GET /v1/library/items/:id`). For a show it is the episode chosen,
/// under the show's name, with the seasons' episodes to choose from, as
/// Infuse's show page is. Full screen, without the tab bar.
struct DetailScreen: View {
  @Environment(AppModel.self) private var model
  let item: MediaItem
  /// The show an episode belongs to, its seasons, and choosing another.
  var show: String? = nil
  var seasons: [Season] = []
  var choose: (MediaItem) -> Void = { _ in }
  @State private var details: ItemDetails?
  @State private var error: String?
  @State private var expanded = false

  var body: some View {
    ScrollView {
      VStack(spacing: 16) {
        header
        VStack(spacing: 6) {
          facts
          if let genres = details?.genres, !genres.isEmpty {
            Text(genres.joined(separator: ", ")).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
          }
        }
        .padding(.horizontal, CardsAcross.margin)
        PlayButton(position: position, duration: duration) { model.play(item) }
          .padding(.horizontal, 40)
        VStack(alignment: .leading, spacing: 20) {
          if let description = details?.description {
            Text(description)
              .font(.callout)
              .lineLimit(expanded ? nil : 3)
              .onTapGesture { withAnimation { expanded.toggle() } }
          }
          ForEach(seasons) { season in
            EpisodeStrip(season: season, chosen: item.id, choose: choose)
          }
          if let ratings = details?.ratings, !ratings.isEmpty {
            HStack(spacing: 20) {
              ForEach(ratings, id: \.self) { rating in
                Label {
                  Text(rating.value.formatted(.number.precision(.fractionLength(0...1))) + (rating.source.map { " \($0)" } ?? ""))
                } icon: {
                  Image(systemName: rating.source == "you" ? "person.fill" : "star.fill").foregroundStyle(.yellow)
                }
                .font(.subheadline)
              }
            }
          }
          if let people = details?.people, !people.isEmpty {
            PeopleRow(people: people)
          }
          information
          if let error {
            Text(error).font(.footnote).foregroundStyle(.secondary)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, CardsAcross.margin)
      }
      .padding(.bottom, 24)
    }
    .ignoresSafeArea(edges: .top)
    .toolbarBackground(.hidden, for: .navigationBar)
    .toolbar(.hidden, for: .tabBar)
    .navigationBarTitleDisplayMode(.inline)
    .task(id: item.id) {
      do {
        details = try await model.browser?.api.details(of: item)
      } catch where !Browser.cancelled(error) {
        // The page still plays from what the card knew.
        self.error = Browser.describe(error).replacingOccurrences(of: "your library", with: "the details")
      } catch {}
    }
    .onChange(of: model.player.isPresented) { _, shown in
      // Back from playing: Yolo has the new position.
      if !shown { Task { details = try? await model.browser?.api.details(of: item) } }
    }
  }

  /// The landscape picture, fading into the page, with the title over it.
  private var header: some View {
    Color.clear
      .aspectRatio(4 / 3, contentMode: .fit)
      .overlay { ArtworkView(thumbnail: item.thumbnail, landscape: true) }
      .clipped()
      .overlay {
        LinearGradient(colors: [.clear, .clear, Color(.systemBackground)], startPoint: .top, endPoint: .bottom)
      }
      .overlay(alignment: .bottom) {
        VStack(spacing: 4) {
          Text(show ?? item.title).font(show == nil ? .title.bold() : .title3.weight(.semibold))
            .lineLimit(3).minimumScaleFactor(0.7)
          if let episode = episodeLine {
            Text(episode).font(show == nil ? .headline : .title2.bold())
          }
        }
        .multilineTextAlignment(.center)
        .padding(.horizontal, CardsAcross.margin)
      }
  }

  private var episodeLine: String? {
    guard item.kind == .episode else { return nil }
    let number = [item.season.map { "S\($0)" }, item.episode.map { "E\($0)" }].compactMap { $0 }.joined(separator: " • ")
    return [number.isEmpty ? nil : number, item.episodeTitle].compactMap { $0 }.joined(separator: " - ")
  }

  private var duration: Double? { details?.duration ?? item.duration }

  /// Yolo's progress, unless the item was watched to its end.
  private var position: Double? {
    let watched = details?.watched ?? item.watched
    let at = details?.position ?? item.position
    guard let at, at > 0, !watched || item.progress > 0 else { return nil }
    return at
  }

  /// The site a web video is on, how long it runs, when it came out, and
  /// its rating in a box, as Infuse's line is.
  private var facts: some View {
    HStack(spacing: 14) {
      if let site = item.site { Text(site) }
      if let duration, duration > 0 {
        let minutes = Int(duration / 60)
        Text(minutes >= 60 ? "\(minutes / 60) h \(minutes % 60) min" : "\(max(1, minutes)) min")
      }
      if let released = Self.released(details?.date) {
        Text(released)
      } else if let year = details?.year ?? item.year {
        Text(String(year))
      }
      if let rating = details?.contentRating {
        Text(rating).font(.caption.weight(.semibold))
          .padding(.horizontal, 5).padding(.vertical, 1)
          .overlay { RoundedRectangle(cornerRadius: 3).stroke(.secondary, lineWidth: 1) }
      }
    }
    .font(.subheadline)
    .foregroundStyle(.secondary)
  }

  /// What the source says about it beyond the story: studio, release date,
  /// and its audio and subtitles.
  @ViewBuilder private var information: some View {
    let rows = [
      ("Studio", details?.studio),
      ("Released", Self.released(details?.date)),
      ("Audio", details.flatMap { $0.audio.isEmpty ? nil : $0.audio.joined(separator: ", ") }),
      ("Subtitles", details.flatMap { $0.subtitles.isEmpty ? nil : $0.subtitles.joined(separator: ", ") }),
    ].compactMap { label, value in value.map { (label, $0) } }
    if !rows.isEmpty {
      VStack(alignment: .leading, spacing: 10) {
        Text("Information").font(.title3.bold())
        ForEach(rows, id: \.0) { label, value in
          VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.subheadline)
          }
        }
      }
    }
  }

  /// "2026-10-09" as "Oct 9, 2026"; a year alone is left to the year.
  static func released(_ date: String?) -> String? {
    guard let date, date.count == 10, let day = try? Date(date, strategy: .iso8601.year().month().day()) else { return nil }
    // The day as written, not that midnight in UTC seen from here.
    var style = Date.FormatStyle.dateTime.month(.abbreviated).day().year()
    style.timeZone = TimeZone(identifier: "UTC")!
    return day.formatted(style)
  }
}

/// A season's episodes in a row, numbered, the chosen one outlined; a tap
/// chooses one for the page above.
struct EpisodeStrip: View {
  @Environment(AppModel.self) private var model
  let season: Season
  let chosen: String
  let choose: (MediaItem) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Season \(season.number)").font(.title3.bold())
      ScrollViewReader { reader in
        ScrollView(.horizontal, showsIndicators: false) {
          LazyHStack(alignment: .top, spacing: 12) {
            ForEach(season.episodes) { episode in
              Button { withAnimation { choose(episode) } } label: { card(episode) }
                .buttonStyle(.plain)
                .id(episode.id)
            }
          }
          .padding(.vertical, 3)
        }
        .task(id: season.id) { await model.artwork?.prefetch(season.episodes.map(\.thumbnail), landscape: true) }
        .padding(.horizontal, -CardsAcross.margin)
        .contentMargins(.horizontal, CardsAcross.margin, for: .scrollContent)
        .onAppear { reader.scrollTo(chosen, anchor: .leading) }
      }
    }
  }

  private func card(_ episode: MediaItem) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Color.clear
        .aspectRatio(16 / 9, contentMode: .fit)
        .overlay { ArtworkView(thumbnail: episode.thumbnail, landscape: true) }
        .overlay(alignment: .bottomLeading) {
          if episode.shownProgress > 0 {
            GeometryReader { proxy in
              ZStack(alignment: .leading) {
                Rectangle().fill(.black.opacity(0.4))
                Rectangle().fill(.white).frame(width: proxy.size.width * episode.shownProgress)
              }
            }
            .frame(height: 3)
          }
        }
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay {
          if episode.id == chosen {
            RoundedRectangle(cornerRadius: 12).stroke(Color.accentColor, lineWidth: 3).padding(-3)
          }
        }
      HStack(alignment: .firstTextBaseline, spacing: 5) {
        if episode.unplayed { Circle().fill(Color.accentColor).frame(width: 7, height: 7) }
        Text([episode.episode.map { "\($0)." }, episode.episodeTitle ?? episode.title].compactMap { $0 }.joined(separator: " "))
          .font(.subheadline).lineLimit(2).multilineTextAlignment(.leading)
      }
    }
    .frame(width: 200)
  }
}

/// Play, or Resume at the time Yolo recorded, as Infuse draws it: a light
/// capsule filled white as far as it played, dark text on it. A position
/// under half a minute is no place to resume from, so it offers Play.
struct PlayButton: View {
  let position: Double?
  let duration: Double?
  let action: () -> Void

  private var resume: Double? { position.flatMap { $0 >= 30 ? $0 : nil } }

  var body: some View {
    Button(action: action) {
      HStack(spacing: 6) {
        if let resume {
          Text("Resume").fontWeight(.semibold) + Text(" " + Self.clock(resume)).foregroundStyle(.black.opacity(0.6))
        } else {
          Image(systemName: "play.fill")
          Text("Play").fontWeight(.semibold)
        }
      }
      .font(.headline.monospacedDigit())
      .foregroundStyle(.black)
      .frame(maxWidth: .infinity, minHeight: 50)
      .background {
        GeometryReader { proxy in
          ZStack(alignment: .leading) {
            Capsule().fill(resume == nil ? .white : Color(white: 0.72))
            if let resume, let duration, duration > 0 {
              Rectangle().fill(.white).frame(width: proxy.size.width * min(1, resume / duration))
            }
          }
        }
      }
      .clipShape(Capsule())
    }
    .buttonStyle(.plain)
  }

  static func clock(_ seconds: Double) -> String {
    let total = Int(seconds)
    return String(format: "%02d:%02d:%02d", total / 3600, total / 60 % 60, total % 60)
  }
}

/// The cast first, then the crew, in a row that scrolls sideways.
struct PeopleRow: View {
  let people: [ItemDetails.Person]

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Cast and Crew").font(.title3.bold())
      ScrollView(.horizontal, showsIndicators: false) {
        LazyHStack(alignment: .top, spacing: 14) {
          ForEach(Array(people.enumerated()), id: \.offset) { _, person in
            VStack(spacing: 6) {
              Circle().fill(.white.opacity(0.1))
                .frame(width: 64, height: 64)
                .overlay { Text(Self.initials(person.name)).font(.headline).foregroundStyle(.secondary) }
              Text(person.name).font(.caption).lineLimit(2).multilineTextAlignment(.center)
              Text(person.role == "cast" ? person.character ?? "" : person.role.capitalized)
                .font(.caption2).foregroundStyle(.secondary).lineLimit(2).multilineTextAlignment(.center)
            }
            .frame(width: 76)
          }
        }
      }
      .padding(.horizontal, -CardsAcross.margin)
      .contentMargins(.horizontal, CardsAcross.margin, for: .scrollContent)
    }
  }

  static func initials(_ name: String) -> String {
    name.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined()
  }
}
