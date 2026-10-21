import SwiftUI

/// Yolo for Apple TV (Agent Note 2026-10-19-apple-tv-client): a screen of
/// kind "tv" that speaks Yolo's client protocol through YoloKit.
@main
struct YoloTVApp: App {
  @State private var model = AppModel()
  @Environment(\.scenePhase) private var scenePhase

  var body: some Scene {
    WindowGroup {
      RootView()
        .environment(model)
        .task { model.launch() }
        .onChange(of: scenePhase) { old, phase in
          // Back from the background, not the launch.
          if phase == .active && old == .background { model.becameActive() }
        }
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
      ZStack(alignment: .topTrailing) {
        PlayerScreen(
          player: model.player.player, caption: model.player.caption, tracks: model.player.tracks,
          chooseSubtitles: { model.chooseSubtitles($0) }, share: { model.share() }
        )
        .ignoresSafeArea()
        if let link = model.shareLink {
          ShareCard(link: link)
        }
      }
    }
  }
}
