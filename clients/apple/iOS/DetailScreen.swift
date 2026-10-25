import SwiftUI
import YoloKit

/// What a cover opens: the item's picture across the top, what it is, Play
/// or Resume where Yolo says it was left, its description, ratings, and the
/// people in it, all from the owner's server (`GET /v1/library/items/:id`).
struct DetailScreen: View {
  @Environment(AppModel.self) private var model
  let item: MediaItem
  @State private var details: ItemDetails?
  @State private var error: String?
  @State private var expanded = false

  var body: some View {
    ScrollView {
      VStack(spacing: 16) {
        header
        VStack(spacing: 6) {
          if let line = factsLine { Text(line).font(.subheadline).foregroundStyle(.secondary) }
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
          Text(item.title).font(.title.bold())
          if let episode = episodeLine {
            Text(episode).font(.headline)
          }
        }
        .multilineTextAlignment(.center)
        .padding(.horizontal, CardsAcross.margin)
      }
  }

  private var episodeLine: String? {
    guard item.kind == .episode else { return nil }
    let number = [item.season.map { "S\($0)" }, item.episode.map { "E\($0)" }].compactMap { $0 }.joined(separator: " · ")
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

  private var factsLine: String? {
    var parts: [String] = []
    if let duration, duration > 0 {
      let minutes = Int(duration / 60)
      parts.append(minutes >= 60 ? "\(minutes / 60) h \(minutes % 60) min" : "\(max(1, minutes)) min")
    }
    if let year = details?.year ?? item.year { parts.append(String(year)) }
    if let rating = details?.contentRating { parts.append(rating) }
    return parts.isEmpty ? nil : parts.joined(separator: "   ")
  }
}

/// Play, or Resume at the time Yolo recorded, filled as far as it played.
struct PlayButton: View {
  let position: Double?
  let duration: Double?
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 6) {
        Image(systemName: "play.fill")
        if let position {
          Text("Resume").bold() + Text(" " + Self.clock(position))
        } else {
          Text("Play").bold()
        }
      }
      .font(.headline)
      .frame(maxWidth: .infinity, minHeight: 50)
      .background {
        GeometryReader { proxy in
          ZStack(alignment: .leading) {
            Capsule().fill(.white.opacity(0.15))
            if let position, let duration, duration > 0 {
              Capsule().fill(.white.opacity(0.25)).frame(width: proxy.size.width * min(1, position / duration))
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
