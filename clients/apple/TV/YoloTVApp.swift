import SwiftUI

/// Yolo for Apple TV (Agent Note 2026-10-19-apple-tv-client): a screen of
/// kind "tv" that speaks Yolo's client protocol through YoloKit.
@main
struct YoloTVApp: App {
  @State private var model = AppModel()

  var body: some Scene {
    WindowGroup {
      RootView()
        .environment(model)
        .task { model.launch() }
    }
  }
}

struct RootView: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    Group {
      switch model.screen {
      case .starting:
        ProgressView()
      case .findServer(let error):
        FindServerView(error: error)
      case .confirm(let server):
        ConfirmServerView(server: server)
      case .checking(let address):
        ProgressView("Checking \(address.host)…")
      case .pairing(let address):
        PairingView(address: address)
      case .updateClient(let address):
        UpdateView(address: address, appIsOlder: true)
      case .updateServer(let address):
        UpdateView(address: address, appIsOlder: false)
      case .ready:
        MainTabs()
      }
    }
    .animation(.default, value: model.screen)
    .fullScreenCover(isPresented: Binding(get: { model.player.isPresented }, set: { shown in
      if !shown { model.leftPlayer() }
    })) {
      PlayerScreen(player: model.player.player).ignoresSafeArea()
    }
  }
}
