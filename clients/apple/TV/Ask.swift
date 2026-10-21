import Foundation
import Observation
import SwiftUI
import YoloKit

/// Ask: a request to the owner's agent, said with the Siri Remote's
/// dictation or typed, in a conversation Yolo keeps for every screen
/// (Agent Notes 2026-10-18-agent-from-the-screen and
/// 2026-10-18-multi-agent-conversations). As the player's `ask.js`, the
/// screen shows the current step and the final sentence, never the agent's
/// words along the way.
@MainActor @Observable
final class AskModel {
  struct Entry: Identifiable, Equatable {
    enum Kind { case question, busy, done, error, stopped }
    let id: String
    var kind: Kind
    var text: String
  }

  private(set) var availability: AgentAvailability?
  private(set) var conversationId: String?
  private(set) var title: String?
  private(set) var entries: [Entry] = []
  private(set) var history: [AgentConversation] = []
  private(set) var running = false

  @ObservationIgnored private let api: APIClient
  @ObservationIgnored private var answer: Task<Void, Never>?
  /// Discards a conversation that loads after the owner moved on.
  @ObservationIgnored private var generation = 0
  /// The last conversation and when, reopened within six hours.
  private static let rememberKey = "yolo.ask.conversation"
  private static let remember: TimeInterval = 6 * 3600

  init(api: APIClient) {
    self.api = api
  }

  /// Whether an agent answers, and its name; a failure leaves it as it was.
  func refresh() async {
    if let availability = try? await api.agent() { self.availability = availability }
  }

  var label: String { availability?.title.map { "Ask \($0)" } ?? "Ask" }

  /// Reopens the conversation of the last six hours, if there is one.
  func reopen() async {
    guard conversationId == nil, entries.isEmpty,
          let stored = UserDefaults.standard.dictionary(forKey: Self.rememberKey),
          let id = stored["id"] as? String, let at = stored["at"] as? Double,
          Date().timeIntervalSince1970 - at < Self.remember
    else { return }
    await open(id)
  }

  private func rememberConversation() {
    guard let conversationId else { return }
    UserDefaults.standard.set(["id": conversationId, "at": Date().timeIntervalSince1970], forKey: Self.rememberKey)
  }

  func newConversation() {
    generation += 1
    conversationId = nil
    title = nil
    entries = []
  }

  func open(_ id: String) async {
    generation += 1
    let current = generation
    guard let conversation = try? await api.conversation(id) else {
      UserDefaults.standard.removeObject(forKey: Self.rememberKey)
      return
    }
    guard current == generation, !running || conversationId != id else { return }
    conversationId = conversation.id
    title = conversation.title
    entries = conversation.messages.map { message in
      if message.role == "user" { return Entry(id: message.id, kind: .question, text: message.text) }
      switch message.status {
      case "done": return Entry(id: message.id, kind: .done, text: message.text)
      case "error": return Entry(id: message.id, kind: .error, text: message.text)
      case "stopped": return Entry(id: message.id, kind: .stopped, text: message.text.isEmpty ? "Stopped." : message.text)
      default: return Entry(id: message.id, kind: .stopped, text: message.text.isEmpty ? "No answer yet." : message.text)
      }
    }
    rememberConversation()
  }

  func loadHistory() async {
    history = (try? await api.conversations()) ?? history
  }

  /// Asks. A new question stops the one running; nothing is retried, since
  /// each request spends the owner's own model plan.
  func send(_ text: String) {
    let question = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !question.isEmpty else { return }
    answer?.cancel()
    let answerId = UUID().uuidString
    entries.append(Entry(id: UUID().uuidString, kind: .question, text: String(question.prefix(1000))))
    entries.append(Entry(id: answerId, kind: .busy, text: "Asking…"))
    running = true
    let conversation = conversationId
    answer = Task {
      var ended = false
      do {
        for try await event in try await api.ask(String(question.prefix(1000)), in: conversation, language: Locale.preferredLanguages.first) {
          switch event {
          case .conversation(let id, let title):
            conversationId = id
            if self.title == nil { self.title = title }
            rememberConversation()
          case .tool(let name): update(answerId, .busy, AgentEvent.step(for: name))
          case .text: break
          case .done(let text):
            ended = true
            update(answerId, .done, text.isEmpty ? "Done." : text)
          case .error(let message):
            ended = true
            update(answerId, .error, message)
          }
        }
        if !ended { update(answerId, .error, "The agent stopped without an answer.") }
      } catch is CancellationError {
        update(answerId, .stopped, "Stopped.")
      } catch let error as URLError where error.code == .cancelled {
        update(answerId, .stopped, "Stopped.")
      } catch let error as YoloAPIError {
        update(answerId, .error, error.message)
      } catch {
        update(answerId, .error, "Yolo could not reach the agent.")
      }
      running = false
      rememberConversation()
    }
  }

  /// Stops the answer: closing the connection stops the agent.
  func stop() {
    answer?.cancel()
  }

  private func update(_ id: String, _ kind: Entry.Kind, _ text: String) {
    guard let index = entries.firstIndex(where: { $0.id == id }) else { return }
    entries[index].kind = kind
    entries[index].text = text
  }
}

struct AskScreen: View {
  @Environment(AppModel.self) private var model
  @State private var text = ""
  @State private var showingHistory = false

  var body: some View {
    if let ask = model.ask {
      VStack(alignment: .leading, spacing: 32) {
        HStack {
          Text(ask.title ?? ask.label).font(.title2.bold()).lineLimit(1)
          Spacer()
          Button("History") { showingHistory = true }
          Button("New") { ask.newConversation() }
        }
        if ask.availability?.available == false {
          Text(ask.availability?.reason ?? "No agent answers on this Yolo.").foregroundStyle(.secondary)
        }
        ScrollViewReader { scroller in
          ScrollView {
            VStack(alignment: .leading, spacing: 20) {
              ForEach(ask.entries) { entry in
                EntryRow(entry: entry).id(entry.id)
              }
            }
          }
          .onChange(of: ask.entries) { _, entries in
            if let last = entries.last { scroller.scrollTo(last.id, anchor: .bottom) }
          }
        }
        HStack(spacing: 24) {
          // On Apple TV the field opens the system's keyboard, where the
          // Siri Remote's microphone button dictates.
          TextField("What do you want to watch?", text: $text)
            .onSubmit(send)
          if ask.running {
            Button("Stop") { ask.stop() }
          } else {
            Button("Send", action: send).disabled(text.trimmingCharacters(in: .whitespaces).isEmpty)
          }
        }
      }
      .padding(80)
      .task {
        await ask.refresh()
        await ask.reopen()
      }
      .sheet(isPresented: $showingHistory) {
        HistorySheet(ask: ask) { showingHistory = false }
      }
    }
  }

  private func send() {
    model.ask?.send(text)
    text = ""
  }
}

private struct EntryRow: View {
  let entry: AskModel.Entry

  var body: some View {
    HStack {
      if entry.kind == .question { Spacer(minLength: 300) }
      HStack(spacing: 16) {
        if entry.kind == .busy { ProgressView() }
        Text(entry.text)
          .foregroundStyle(entry.kind == .error ? .red : entry.kind == .busy || entry.kind == .stopped ? .secondary : .primary)
      }
      .padding(20)
      .background(entry.kind == .question ? Color.white.opacity(0.18) : Color.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 18))
      if entry.kind != .question { Spacer(minLength: 300) }
    }
  }
}

private struct HistorySheet: View {
  let ask: AskModel
  let close: () -> Void

  var body: some View {
    NavigationStack {
      List(ask.history) { conversation in
        Button {
          Task { await ask.open(conversation.id) }
          close()
        } label: {
          VStack(alignment: .leading) {
            Text(conversation.title).lineLimit(1)
            if let updated = conversation.updatedAt {
              Text(updated, format: Calendar.current.isDateInToday(updated) ? .dateTime.hour().minute() : .dateTime.month().day())
                .font(.caption).foregroundStyle(.secondary)
            }
          }
        }
      }
      .navigationTitle("Conversations")
      .task { await ask.loadHistory() }
    }
  }
}
