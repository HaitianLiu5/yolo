import Testing
@testable import YoloKit

@Suite struct LanguageTests {
  @Test func aChoiceWinsOverTheSystem() {
    #expect(ScreenLanguage.resolve(chosen: .simplifiedChinese, preferred: ["en-US"]) == .simplifiedChinese)
    #expect(ScreenLanguage.resolve(chosen: .english, preferred: ["zh-Hans-CN"]) == .english)
  }

  @Test func withoutAChoiceTheFirstChineseOrEnglishOfTheSystemsLanguagesDecides() {
    #expect(ScreenLanguage.resolve(chosen: nil, preferred: ["en-US", "zh-Hans-US"]) == .english)
    #expect(ScreenLanguage.resolve(chosen: nil, preferred: ["zh-Hant-TW", "en"]) == .simplifiedChinese)
    #expect(ScreenLanguage.resolve(chosen: nil, preferred: ["ja-JP", "zh-Hans"]) == .simplifiedChinese)
    #expect(ScreenLanguage.resolve(chosen: nil, preferred: ["ja-JP"]) == .english)
    #expect(ScreenLanguage.resolve(chosen: nil, preferred: []) == .english)
  }

  @Test func theAccountsLanguageComesBetweenTheChoiceAndTheSystem() {
    #expect(ScreenLanguage.resolve(chosen: .english, account: .simplifiedChinese, preferred: []) == .english)
    #expect(ScreenLanguage.resolve(chosen: nil, account: .simplifiedChinese, preferred: ["en-US"]) == .simplifiedChinese)
    #expect(ScreenLanguage.request(chosen: nil, account: .simplifiedChinese, preferred: ["en-US"]) == "zh-Hans")
    #expect(ScreenLanguage.request(chosen: .english, account: .simplifiedChinese, preferred: []) == "en")
  }

  @Test func aWelcomeSaysTheAccountsLanguageNoneOrNothing() throws {
    func welcome(_ fields: String) throws -> Welcome {
      let message = try #require(RealtimeMessage(text: #"{"v":1,"type":"welcome"\#(fields)}"#))
      return try #require(Welcome(message))
    }
    #expect(try welcome(#","language":"zh-Hans""#).language?.string == "zh-Hans")
    #expect(try welcome(#","language":null"#).language?.isNull == true)
    #expect(try welcome("").language == nil)
  }

  @Test func requestsCarryTheChoiceElseTheSystemsFirstLanguage() {
    #expect(ScreenLanguage.request(chosen: .simplifiedChinese, preferred: ["en-US"]) == "zh-Hans")
    #expect(ScreenLanguage.request(chosen: nil, preferred: ["ja-JP", "en"]) == "ja-JP")
    #expect(ScreenLanguage.request(chosen: nil, preferred: []) == nil)
  }
}
