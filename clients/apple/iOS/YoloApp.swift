import SwiftUI
import UIKit

/// Yolo for iPhone and iPad (Agent Note 2026-10-23-iphone-and-ipad-client):
/// a screen of kind "phone" that speaks Yolo's client protocol through
/// YoloKit and the app layer it shares with the Apple TV app.
@main
struct YoloApp: App {
  @UIApplicationDelegateAdaptor private var delegate: AppDelegate
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
    // The player opens at the tap and shows its loading there, as Infuse's
    // does, until the stream's `load` arrives.
    .onChange(of: model.player.isPresented || model.starting != nil) { _, shown in
      PlayerPresenter.shared.show(shown, model: model)
    }
  }
}

/// Presents the player as Infuse does: a black screen slides in from the
/// right while the phone is still upright, the phone turns to landscape
/// behind that black, and the player fades in; closing fades to black,
/// turns back upright, and slides out to the right.
@MainActor
final class PlayerPresenter {
  static let shared = PlayerPresenter()
  private weak var presented: PlayerHost?

  func show(_ shown: Bool, model: AppModel) {
    if shown {
      guard presented == nil,
            let root = (UIApplication.shared.connectedScenes.first as? UIWindowScene)?.keyWindow?.rootViewController
      else { return }
      Orientation.opening()
      let host = PlayerHost(rootView: AnyView(PlayerScreen().environment(model)))
      var top: UIViewController = root
      while let next = top.presentedViewController { top = next }
      top.present(host, animated: true) { host.turn(landscape: true) }
      presented = host
    } else if let presented {
      self.presented = nil
      presented.turn(landscape: false) {
        presented.dismiss(animated: true) { Orientation.closed() }
      }
    }
  }
}

/// The player's screen. On an iPhone it is upright while it slides in or
/// out and landscape in between; a black cover hides the picture while it
/// slides and turns. An iPad keeps the way it is held.
final class PlayerHost: UIHostingController<AnyView>, UIViewControllerTransitioningDelegate {
  private let cover = UIView()
  private var landscape = false
  private var turned: (() -> Void)?
  private var phone: Bool { UIDevice.current.userInterfaceIdiom == .phone }

  override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
    phone ? (landscape ? .landscape : .portrait) : .all
  }
  override var prefersStatusBarHidden: Bool { true }
  override var prefersHomeIndicatorAutoHidden: Bool { true }

  override init(rootView: AnyView) {
    super.init(rootView: rootView)
    modalPresentationStyle = .fullScreen
    transitioningDelegate = self
    view.backgroundColor = .black
    cover.backgroundColor = .black
    cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
  }

  @MainActor required dynamic init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

  override func viewDidLoad() {
    super.viewDidLoad()
    cover.frame = view.bounds
    view.addSubview(cover)
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    view.bringSubviewToFront(cover)
  }

  /// Turns to landscape and uncovers the player, or covers it and turns
  /// upright; `done` runs once it has turned.
  func turn(landscape: Bool, done: (() -> Void)? = nil) {
    guard phone, let scene = view.window?.windowScene else {
      UIView.animate(withDuration: 0.2) { self.cover.alpha = landscape ? 0 : 1 } completion: { _ in done?() }
      return
    }
    let finish = { [weak self] in
      guard let self else { return }
      if landscape {
        UIView.animate(withDuration: 0.25) { self.cover.alpha = 0 } completion: { _ in done?() }
      } else {
        done?()
      }
    }
    let go = { [weak self] in
      guard let self else { return }
      self.landscape = landscape
      if !landscape { Orientation.holdPortrait() }
      self.setNeedsUpdateOfSupportedInterfaceOrientations()
      let wide = self.view.bounds.width > self.view.bounds.height
      if wide == landscape {
        finish()
      } else {
        self.turned = finish
        scene.requestGeometryUpdate(.iOS(interfaceOrientations: landscape ? .landscape : .portrait))
        // Never left covered should the system not turn.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
          guard let turned = self?.turned else { return }
          self?.turned = nil
          turned()
        }
      }
    }
    if landscape {
      go()
    } else {
      UIView.animate(withDuration: 0.15) { self.cover.alpha = 1 } completion: { _ in go() }
    }
  }

  override func viewWillTransition(to size: CGSize, with coordinator: any UIViewControllerTransitionCoordinator) {
    super.viewWillTransition(to: size, with: coordinator)
    coordinator.animate(alongsideTransition: nil) { [weak self] _ in
      let turned = self?.turned
      self?.turned = nil
      turned?()
    }
  }

  func animationController(forPresented presented: UIViewController, presenting: UIViewController, source: UIViewController)
    -> (any UIViewControllerAnimatedTransitioning)? { SlideTransition(presenting: true) }

  func animationController(forDismissed dismissed: UIViewController) -> (any UIViewControllerAnimatedTransitioning)? {
    SlideTransition(presenting: false)
  }
}

/// The player's screen sliding in from the right over browsing, which
/// moves a little left behind it, and out the same way.
private final class SlideTransition: NSObject, UIViewControllerAnimatedTransitioning {
  let presenting: Bool

  init(presenting: Bool) { self.presenting = presenting }

  func transitionDuration(using context: (any UIViewControllerContextTransitioning)?) -> TimeInterval { 0.35 }

  func animateTransition(using context: any UIViewControllerContextTransitioning) {
    let container = context.containerView
    let width = container.bounds.width
    guard let player = context.view(forKey: presenting ? .to : .from) else {
      context.completeTransition(false)
      return
    }
    let below = context.view(forKey: presenting ? .from : .to)
    if presenting {
      player.frame = container.bounds.offsetBy(dx: width, dy: 0)
      container.addSubview(player)
    } else if let below {
      below.frame = container.bounds.offsetBy(dx: -width * 0.3, dy: 0)
      container.insertSubview(below, belowSubview: player)
    }
    UIView.animate(withDuration: transitionDuration(using: context), delay: 0, options: .curveEaseInOut) {
      player.frame = container.bounds.offsetBy(dx: self.presenting ? 0 : width, dy: 0)
      below?.frame = container.bounds.offsetBy(dx: self.presenting ? -width * 0.3 : 0, dy: 0)
    } completion: { _ in
      if !self.presenting { below?.frame = container.bounds }
      context.completeTransition(!context.transitionWasCancelled)
    }
  }
}

/// The orientations the app allows, which playback narrows on iPhone.
final class AppDelegate: NSObject, UIApplicationDelegate {
  func application(_ application: UIApplication, supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
    MainActor.assumeIsolated { Orientation.allowed }
  }
}

/// The orientations the app allows. The player's screen asks for landscape
/// itself (`PlayerHost`); once it closes the app holds portrait until the
/// phone itself stands upright, so a phone still held sideways does not
/// leave browsing in landscape, and from then on browsing turns freely. An
/// iPad keeps the way it is held.
@MainActor
enum Orientation {
  static var allowed: UIInterfaceOrientationMask = .all
  private static var upright: NSObjectProtocol?

  /// Lets the player's screen turn to landscape.
  static func opening() {
    upright.map(NotificationCenter.default.removeObserver)
    upright = nil
    if UIDevice.current.userInterfaceIdiom == .phone { allowed = .allButUpsideDown }
  }

  /// Closing: portrait only, so the player's screen can turn upright.
  static func holdPortrait() {
    if UIDevice.current.userInterfaceIdiom == .phone { allowed = .portrait }
  }

  /// Back to browsing: portrait until the phone stands upright.
  static func closed() {
    guard UIDevice.current.userInterfaceIdiom == .phone,
          let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene
    else { return }
    allowed = .portrait
    scene.keyWindow?.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
    UIDevice.current.beginGeneratingDeviceOrientationNotifications()
    upright = NotificationCenter.default.addObserver(forName: UIDevice.orientationDidChangeNotification, object: nil, queue: .main) { _ in
      MainActor.assumeIsolated {
        guard UIDevice.current.orientation == .portrait, let observer = upright else { return }
        NotificationCenter.default.removeObserver(observer)
        upright = nil
        UIDevice.current.endGeneratingDeviceOrientationNotifications()
        allowed = .allButUpsideDown
        scene.keyWindow?.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
      }
    }
  }
}
