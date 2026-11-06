import Foundation

/// The languages the apps show, each named in its own language, and what a
/// screen's choice means (Agent Note 2026-10-26-player-language), as the
/// player's `i18n.js`. The app layer keeps the choice and looks up the text.
public enum ScreenLanguage: String, CaseIterable, Sendable, Hashable {
  case english = "en"
  case simplifiedChinese = "zh-Hans"

  public var name: String {
    switch self {
    case .english: "English"
    case .simplifiedChinese: "简体中文"
    }
  }

  /// The language a choice means: the screen's own, then the account's
  /// (Agent Note 2026-11-06-account-language). Without either, the system's
  /// languages in order: the first that is Chinese, in any script or region,
  /// means Simplified Chinese, the first that is English means English, and
  /// none of either means English.
  public static func resolve(chosen: ScreenLanguage?, account: ScreenLanguage? = nil, preferred: [String]) -> ScreenLanguage {
    if let language = chosen ?? account { return language }
    for tag in preferred {
      switch tag.split(whereSeparator: { $0 == "-" || $0 == "_" }).first?.lowercased() {
      case "zh": return .simplifiedChinese
      case "en": return .english
      default: continue
      }
    }
    return .english
  }

  /// The language that goes with what a screen says to Yolo: the one chosen
  /// here or for the account, or else the system's own, a hint so a Japanese
  /// device's words are still heard as Japanese.
  public static func request(chosen: ScreenLanguage?, account: ScreenLanguage? = nil, preferred: [String]) -> String? {
    (chosen ?? account)?.rawValue ?? preferred.first
  }
}
