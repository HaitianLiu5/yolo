import SwiftUI
import YoloKit

// The agent canvas on Apple TV (Agent Note 2026-10-21-agent-canvas): the
// agent says what to show, and this screen draws it the tvOS way. Choices
// are a spotlight of large cards over Home when nothing plays here, and a
// shelf rising from the bottom over the picture while something does, which
// keeps playing, with Play After This on each. Notes and pictures are small
// cards in the top corner. Each takes the Siri Remote's focus when it
// appears, and Menu closes it.

/// The canvas over Home, or over the player with `playing`.
struct CanvasLayer: View {
  @Environment(AppModel.self) private var model
  let playing: Bool

  var body: some View {
    let now = model.canvasNow
    ZStack {
      let cards = model.canvas.cards(at: now)
      if !cards.isEmpty {
        CanvasCards(objects: cards)
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
      }
      if let choices = model.canvas.choices(at: now), case .choices(let title, let options) = choices.content {
        if playing {
          CanvasShelf(object: choices, title: title ?? "Which one?", options: options)
            .frame(maxHeight: .infinity, alignment: .bottom)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        } else {
          CanvasSpotlight(object: choices, title: title ?? "Which one?", options: options)
            .transition(.opacity)
        }
      }
    }
    .animation(.easeOut(duration: 0.3), value: model.canvas.shown(at: now).map(\.id))
  }
}

/// Choices over Home: the screen dims and the options take it, large.
struct CanvasSpotlight: View {
  @Environment(AppModel.self) private var model
  let object: CanvasObject
  let title: String
  let options: [CanvasChoice]
  @FocusState private var focused: Int?

  var body: some View {
    ZStack {
      Rectangle().fill(.black.opacity(0.75)).background(.ultraThinMaterial).ignoresSafeArea()
      VStack(alignment: .leading, spacing: 40) {
        Text(title).font(.title2.bold())
        ScrollView(.horizontal) {
          HStack(alignment: .top, spacing: 56) {
            ForEach(options) { option in
              CanvasChoiceCard(option: option, size: CGSize(width: 480, height: 270)) {
                model.pick(option, of: object)
              }
              .focused($focused, equals: option.index)
            }
          }
          .padding(.vertical, 32)
          .padding(.horizontal, 8)
        }
        .scrollClipDisabled()
        Button("Close") { model.dismiss(object) }
          .focused($focused, equals: -1)
      }
      .padding(80)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .focusSection()
    .defaultFocus($focused, options.first?.index)
    .onAppear { focused = options.first?.index }
    .onExitCommand { model.dismiss(object) }
  }
}

/// Choices over the player: a shelf along the bottom, the picture playing
/// above it. Each option plays now, or after what plays.
struct CanvasShelf: View {
  @Environment(AppModel.self) private var model
  let object: CanvasObject
  let title: String
  let options: [CanvasChoice]
  @FocusState private var focused: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 24) {
      HStack {
        Text(title).font(.title3.bold())
        Spacer()
        Button("Close") { model.dismiss(object) }
          .focused($focused, equals: "close")
      }
      ScrollView(.horizontal) {
        HStack(alignment: .top, spacing: 48) {
          ForEach(options) { option in
            VStack(alignment: .leading, spacing: 16) {
              CanvasChoiceCard(option: option, size: CGSize(width: 400, height: 225)) {
                model.pick(option, of: object)
              }
              .focused($focused, equals: "play-\(option.index)")
              if option.item != nil {
                Button { model.pick(option, of: object, after: true) } label: {
                  Label("Play After This", systemImage: "text.line.last.and.arrowtriangle.forward")
                    .font(.caption)
                }
                .focused($focused, equals: "after-\(option.index)")
              }
            }
          }
        }
        .padding(.vertical, 24)
        .padding(.horizontal, 8)
      }
      .scrollClipDisabled()
    }
    .padding(.horizontal, 80)
    .padding(.top, 48)
    .padding(.bottom, 60)
    .background(LinearGradient(colors: [.clear, .black.opacity(0.9)], startPoint: .top, endPoint: UnitPoint(x: 0.5, y: 0.35)).ignoresSafeArea())
    .focusSection()
    .defaultFocus($focused, options.first.map { "play-\($0.index)" })
    .onAppear { focused = options.first.map { "play-\($0.index)" } }
    .onExitCommand { model.dismiss(object) }
  }
}

/// One option: an item's picture, title, and the agent's line, or a label
/// that asks the agent for something else.
struct CanvasChoiceCard: View {
  let option: CanvasChoice
  let size: CGSize
  let action: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Button(action: action) {
        if let item = option.item {
          ArtworkView(thumbnail: item.thumbnail, landscape: true)
            .frame(width: size.width, height: size.height)
        } else {
          ZStack {
            Rectangle().fill(.white.opacity(0.1))
            Text(option.label ?? "Something else")
              .font(.title3.bold()).multilineTextAlignment(.center).padding(24)
          }
          .frame(width: size.width, height: size.height)
        }
      }
      .buttonStyle(.card)
      if let item = option.item {
        Text(item.title ?? "Untitled").font(.callout).lineLimit(1)
      }
      if let line = [option.note, option.item?.duration.flatMap(Self.runtime)].compactMap({ $0 }).joined(separator: " · ").nilIfEmpty {
        Text(line).font(.caption).foregroundStyle(.secondary).lineLimit(2)
      }
    }
    .frame(width: size.width, alignment: .leading)
  }

  static func runtime(_ duration: Double) -> String? {
    guard duration > 0 else { return nil }
    let minutes = Int(duration / 60)
    return minutes >= 60 ? "\(minutes / 60) h \(minutes % 60) min" : "\(max(1, minutes)) min"
  }
}

/// Notes, pictures, and kinds this screen does not draw (their fallback),
/// stacked in the top corner, the newest first focused.
struct CanvasCards: View {
  @Environment(AppModel.self) private var model
  let objects: [CanvasObject]
  @FocusState private var focused: String?

  var body: some View {
    VStack(alignment: .trailing, spacing: 24) {
      ForEach(objects.reversed()) { object in
        CanvasCard(object: object, focused: $focused)
      }
    }
    .padding(60)
    .focusSection()
    .onChange(of: objects.last?.id, initial: true) { _, newest in
      if let newest { focused = newest }
    }
  }
}

struct CanvasCard: View {
  @Environment(AppModel.self) private var model
  let object: CanvasObject
  var focused: FocusState<String?>.Binding

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      if case .image(let url, _, _) = object.content {
        ArtworkView(thumbnail: url, landscape: false)
          .aspectRatio(16 / 9, contentMode: .fit)
          .frame(maxWidth: .infinity)
          .clipShape(RoundedRectangle(cornerRadius: 12))
          .accessibilityLabel(alt ?? "")
      }
      if let title {
        Text(title).font(.headline).lineLimit(2)
      }
      if let text {
        Text(text).font(.callout).foregroundStyle(.secondary).lineLimit(6)
      }
      HStack(spacing: 20) {
        if object.pressable {
          Button("Open") { model.press(object) }
        }
        Button("Close") { model.dismiss(object) }
          .focused(focused, equals: object.id)
      }
      .font(.caption)
    }
    .padding(28)
    .frame(width: 560, alignment: .leading)
    .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 24))
    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 24))
    .onExitCommand { model.dismiss(object) }
  }

  private var title: String? {
    switch object.content {
    case .note(let title, _), .image(_, _, let title), .fallback(let title, _): title
    case .choices(let title, _): title
    }
  }

  private var text: String? {
    switch object.content {
    case .note(_, let text): text
    case .fallback(_, let text): text
    default: nil
    }
  }

  private var alt: String? {
    if case .image(_, let alt, _) = object.content { alt } else { nil }
  }
}

private extension String {
  var nilIfEmpty: String? { isEmpty ? nil : self }
}
