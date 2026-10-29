import AppKit
import Observation
import ServiceManagement

/// 메뉴바와 설정 창이 함께 쓰는 상태. 감시 프로세스의 status.json과 runs.jsonl을 읽고, 바꾸는 일은 CLI에 맡긴다.
@MainActor
@Observable
final class AppModel {
    static let shared = AppModel()

    private(set) var cli: CLI?
    private(set) var setupError: String?
    private(set) var configSnapshot: ConfigSnapshot?
    private(set) var status: DaemonStatus?
    private(set) var daemonRunning = false
    private(set) var recentRuns: [RunEntry] = []
    private(set) var service: ServiceInfo?
    private(set) var doctor: DoctorResult?
    private(set) var isCheckingEnvironment = false
    private(set) var repos: [RepoItem] = []
    private(set) var isLoadingRepos = false
    private(set) var reposError: String?
    private(set) var isApplyingService = false
    private(set) var opensAtLogin = SMAppService.mainApp.status == .enabled
    /// 마지막 작업의 결과나 오류. 설정 창 아래에 보여 준다.
    var notice: String?

    @ObservationIgnored private var statusTask: Task<Void, Never>?
    @ObservationIgnored private var runsFileStamp: FileStamp?

    private struct FileStamp: Equatable {
        let modified: Date
        let size: Int
    }

    var config: ReviewerConfig? { configSnapshot?.config }
    var isAutoReviewOn: Bool { service?.loaded == true }

    /// 자동 실행이 npm 전역 설치처럼 이 앱 밖의 CLI로 등록돼 있으면, 앱을 업데이트해도 감시 프로세스는 바뀌지 않는다.
    var autoReviewUsesOtherCLI: Bool {
        guard let service, service.loaded, let registered = service.scriptPath, let cli else { return false }
        let resolve = { (path: String) in URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path }
        return resolve(registered) != resolve(cli.scriptURL.path)
    }

    /// 자동 리뷰를 켜려면 저장된 설정에 저장소가 있고, 필수 도구와 선택한 엔진이 준비돼 있어야 한다.
    var canEnableAutoReview: Bool {
        guard let config, configSnapshot?.exists == true, !config.repos.isEmpty else { return false }
        guard let doctor else { return true }
        let toolsReady = ["node", "gh", "git"].allSatisfy { doctor.check($0)?.ok == true }
        return toolsReady && doctor.check(config.engine)?.ok == true
    }

    var menuBarSymbol: String {
        guard setupError == nil, daemonRunning, let status else { return "exclamationmark.bubble" }
        switch status.phase {
        case "reviewing": return "ellipsis.bubble"
        case "paused": return "pause.circle"
        default: return status.lastError == nil ? "text.bubble" : "exclamationmark.bubble"
        }
    }

    // MARK: - 시작

    func start() async {
        guard cli == nil, setupError == nil else { return }
        do {
            cli = try await CLI.locate()
        } catch {
            setupError = error.localizedDescription
            openSettings()
            return
        }
        await loadConfig()
        await refreshService()
        refreshStatus()
        startStatusLoop()
        let needsSetup = configSnapshot?.exists != true || (config?.repos.isEmpty ?? true) || !isAutoReviewOn
        if Snapshot.directory != nil {
            await Snapshot.captureAll(model: self)
        } else if needsSetup {
            openSettings()
        }
    }

    func openSettings() {
        SettingsWindowController.shared.show(model: self)
        guard cli != nil else { return }
        Task {
            await refreshService()
            if doctor == nil { await checkEnvironment() }
        }
    }

    private func startStatusLoop() {
        statusTask?.cancel()
        statusTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                self?.refreshStatus()
            }
        }
    }

    // MARK: - 상태 읽기

    /// status.json과 runs.jsonl을 다시 읽는다. 값이 바뀐 경우에만 화면을 갱신한다.
    func refreshStatus() {
        guard let stateDir = config?.stateDir else { return }
        let directory = URL(fileURLWithPath: stateDir)
        let next = (try? Data(contentsOf: directory.appendingPathComponent("status.json")))
            .flatMap { try? makeDecoder().decode(DaemonStatus.self, from: $0) }
        if next != status { status = next }
        let running = next.map { $0.phase != "stopped" && Self.isProcessAlive($0.pid) } ?? false
        if running != daemonRunning { daemonRunning = running }

        let runsPath = directory.appendingPathComponent("runs.jsonl").path
        let attributes = try? FileManager.default.attributesOfItem(atPath: runsPath)
        let stamp = attributes.map {
            FileStamp(modified: $0[.modificationDate] as? Date ?? .distantPast, size: ($0[.size] as? NSNumber)?.intValue ?? 0)
        }
        if stamp != runsFileStamp {
            runsFileStamp = stamp
            recentRuns = Self.readRecentRuns(path: runsPath, limit: 8)
        }
    }

    private nonisolated static func isProcessAlive(_ pid: Int32) -> Bool {
        pid > 0 && (kill(pid, 0) == 0 || errno == EPERM)
    }

    /// 실행 기록은 계속 늘어나므로 파일 끝 256KB만 읽어 최근 항목을 최신순으로 돌려준다.
    private nonisolated static func readRecentRuns(path: String, limit: Int) -> [RunEntry] {
        guard let file = FileHandle(forReadingAtPath: path) else { return [] }
        defer { try? file.close() }
        let size = (try? file.seekToEnd()) ?? 0
        let start = size > 256_000 ? size - 256_000 : 0
        try? file.seek(toOffset: start)
        let data = (try? file.readToEnd()) ?? Data()
        var lines = String(decoding: data, as: UTF8.self).split(separator: "\n")
        if start > 0, !lines.isEmpty { lines.removeFirst() }
        let decoder = makeDecoder()
        return Array(lines.reversed().lazy.compactMap { try? decoder.decode(RunEntry.self, from: Data($0.utf8)) }.prefix(limit))
    }

    // MARK: - CLI 호출

    func loadConfig() async {
        guard let cli else { return }
        do {
            let snapshot = try await cli.decode(ConfigSnapshot.self, ["config", "show", "--json"])
            if snapshot != configSnapshot { configSnapshot = snapshot }
        } catch {
            notice = "설정을 읽지 못했습니다: \(error.localizedDescription)"
        }
    }

    func refreshService() async {
        guard let cli else { return }
        let next = try? await cli.decode(ServiceInfo.self, ["service", "status", "--json"])
        if next != service { service = next }
    }

    func checkEnvironment() async {
        guard let cli, !isCheckingEnvironment else { return }
        isCheckingEnvironment = true
        defer { isCheckingEnvironment = false }
        do {
            doctor = try await cli.decode(DoctorResult.self, ["doctor", "--json"], timeout: .seconds(180))
        } catch {
            notice = "환경 점검에 실패했습니다: \(error.localizedDescription)"
        }
    }

    func loadRepos() async {
        guard let cli, !isLoadingRepos else { return }
        isLoadingRepos = true
        reposError = nil
        defer { isLoadingRepos = false }
        do {
            repos = try await cli.decode([RepoItem].self, ["repos", "--json"], timeout: .seconds(180))
        } catch {
            reposError = "저장소 목록을 불러오지 못했습니다: \(error.localizedDescription)"
        }
    }

    /// 설정 창의 값을 저장한다. 감시 중이면 바로 조회하게 해서 바뀐 설정을 곧바로 적용한다.
    func save(_ draft: SettingsDraft) async -> Bool {
        guard let cli else { return false }
        do {
            try await cli.run(["config", "set"], input: try draft.patchJSON())
            await loadConfig()
            if daemonRunning { _ = try? await cli.run(["ctl", "poll-now"]) }
            notice = "저장했습니다."
            return true
        } catch {
            notice = error.localizedDescription
            return false
        }
    }

    func setAutoReview(_ enabled: Bool) async {
        guard let cli, !isApplyingService else { return }
        isApplyingService = true
        defer { isApplyingService = false }
        do {
            try await cli.run(["service", enabled ? "install" : "uninstall"], timeout: .seconds(60))
            notice = enabled ? "로그인 시 자동 리뷰를 등록했습니다." : "자동 리뷰 등록을 해제했습니다."
        } catch {
            notice = error.localizedDescription
        }
        await refreshService()
        try? await Task.sleep(for: .seconds(1))
        refreshStatus()
    }

    func setOpensAtLogin(_ enabled: Bool) {
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            notice = "로그인 항목을 바꾸지 못했습니다: \(error.localizedDescription)"
        }
        opensAtLogin = SMAppService.mainApp.status == .enabled
    }

    /// ctl pause·resume·poll-now
    func control(_ action: String) async {
        guard let cli else { return }
        do {
            try await cli.run(["ctl", action])
        } catch {
            notice = error.localizedDescription
        }
        try? await Task.sleep(for: .milliseconds(500))
        refreshStatus()
    }

    // MARK: - 열기

    /// 실행 기록이나 상태 파일의 주소는 GitHub 주소일 때만 연다.
    func openGitHub(_ address: String?) {
        guard let address, address.hasPrefix("https://github.com/"), let url = URL(string: address) else { return }
        NSWorkspace.shared.open(url)
    }

    func pullRequestAddress(repo: String, pr: Int, url: String?) -> String? {
        if let url { return url }
        let pattern = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/
        return repo.wholeMatch(of: pattern) == nil ? nil : "https://github.com/\(repo)/pull/\(pr)"
    }

    /// dry-run 결과처럼 PR에 올리지 않은 리뷰는 stateDir/reviews 안의 파일만 연다.
    func openReviewFile(_ path: String?) {
        guard let path, let stateDir = config?.stateDir else { return }
        let reviews = URL(fileURLWithPath: stateDir).appendingPathComponent("reviews").standardizedFileURL.path + "/"
        let file = URL(fileURLWithPath: path).standardizedFileURL
        guard file.path.hasPrefix(reviews) else { return }
        NSWorkspace.shared.open(file)
    }

    func openLog() {
        guard let logPath = service?.logPath else { return }
        let logs = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/").path
        let file = URL(fileURLWithPath: logPath).standardizedFileURL
        guard file.path.hasPrefix(logs), FileManager.default.fileExists(atPath: file.path) else {
            notice = "아직 로그 파일이 없습니다."
            return
        }
        NSWorkspace.shared.open(file)
    }
}
