import Foundation
import Observation
import SwiftUI
import YoloKit

/// The language this device shows and is heard in (Agent Note
/// 2026-10-26-player-language): English or Simplified Chinese, its own choice
/// kept in UserDefaults, and on Automatic the account's language, then the
/// system's. The English text is the key, in `Localizable.xcstrings`.
///
/// SwiftUI looks a literal up in the environment's locale, which `RootView`
/// and the iPhone's player set from `locale`, so `Text("Home")` needs nothing
/// more. Text that is a `String` before SwiftUI sees it goes through `t()`,
/// which reads the language through observation, so a view that called it
/// draws again when the language changes. A change therefore applies at once,
/// without leaving Settings or disturbing what plays. A navigation title and
/// a search prompt go through `t()` too: the bar can keep a literal's old
/// language after a second change.
@MainActor @Observable
final class Language {
  static let shared = Language()

  private static let key = "yolo.language"
  private static let accountKey = "yolo.accountLanguage"
  /// The system's per-app language. Only it reaches what the system draws
  /// for the app (the keyboard, AVKit's own menus, system alerts), which
  /// reads it once, as the app launches. Written only when the choice or the
  /// account's language changes; with neither it is removed, so the languages
  /// in Settings on the device are the ones followed.
  private static let systemKey = "AppleLanguages"

  /// nil for Automatic.
  private(set) var chosen: ScreenLanguage?
  /// The account's language as this device last heard it; nil for none or a
  /// language this release does not show (Agent Note
  /// 2026-11-06-account-language).
  private(set) var account: ScreenLanguage?
  private(set) var shown = ScreenLanguage.english
  private(set) var locale = Locale.current
  /// Holds the shown language's table, whatever `Bundle.main` chose at launch.
  private(set) var bundle = Bundle.main

  private init() {
    chosen = UserDefaults.standard.string(forKey: Self.key).flatMap(ScreenLanguage.init(rawValue:))
    account = UserDefaults.standard.string(forKey: Self.accountKey).flatMap(ScreenLanguage.init(rawValue:))
    apply()
  }

  func choose(_ language: ScreenLanguage?) {
    chosen = language
    UserDefaults.standard.set(language?.rawValue, forKey: Self.key)
    tellTheSystem()
    apply()
  }

  /// What Yolo says the account's language is, kept for the next launch. It
  /// draws here at once, like a choice, which leaves whatever plays alone.
  func heardAccount(_ tag: String?) {
    let language = tag.flatMap(ScreenLanguage.init(rawValue:))
    guard language != account else { return }
    account = language
    UserDefaults.standard.set(language?.rawValue, forKey: Self.accountKey)
    tellTheSystem()
    apply()
  }

  private func tellTheSystem() {
    UserDefaults.standard.set((chosen ?? account).map { [$0.rawValue] }, forKey: Self.systemKey)
  }

  private func apply() {
    shown = ScreenLanguage.resolve(chosen: chosen, account: account, preferred: Locale.preferredLanguages)
    // The language with this device's region, for how dates are written.
    let region = Locale.current.region.map { "-\($0.identifier)" } ?? ""
    locale = Locale(identifier: shown.rawValue + region)
    let table = Bundle.main.path(forResource: shown.rawValue, ofType: "lproj").flatMap(Bundle.init(path:))
    bundle = table ?? .main
  }

  /// What goes with a request to Yolo: the choice or the account's, else the
  /// system's own.
  var request: String? {
    ScreenLanguage.request(chosen: chosen, account: account, preferred: Locale.preferredLanguages)
  }
}

/// `text` in this device's language, for text that is a `String` before
/// SwiftUI sees it. Written with a literal, as `t("Up Next")` or
/// `t("Season \(number)")`, which the catalog's gate reads.
@MainActor
func t(_ text: String.LocalizationValue) -> String {
  let language = Language.shared
  return String(localized: text, bundle: language.bundle, locale: language.locale)
}
