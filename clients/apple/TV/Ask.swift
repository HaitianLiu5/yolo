import SwiftUI
import YoloKit

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
