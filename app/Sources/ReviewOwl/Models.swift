import Foundation

/// CLI와 감시 프로세스가 쓰는 날짜는 ISO 8601(밀리초 포함)이다.
func makeDecoder() -> JSONDecoder {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { decoder in
        let container = try decoder.singleValueContainer()
        let text = try container.decode(String.self)
        if let date = try? Date(text, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) { return date }
        if let date = try? Date(text, strategy: Date.ISO8601FormatStyle()) { return date }
        throw DecodingError.dataCorruptedError(in: container, debugDescription: "ISO 8601 날짜가 아닙니다: \(text)")
    }
    return decoder
}

/// 감시 프로세스가 stateDir/status.json에 쓰는 상태. src/status.ts의 DaemonStatus와 같은 모양이다.
struct DaemonStatus: Decodable, Sendable, Equatable {
    struct CurrentReview: Decodable, Sendable, Equatable {
        let repo: String
        let pr: Int
        let title: String
        let sha: String
        let startedAt: Date
    }

    struct PendingPR: Decodable, Sendable, Equatable, Identifiable {
        let repo: String
        let pr: Int
        let title: String
        let isDraft: Bool
        let url: String
        let reason: String
        var id: String { "\(repo)#\(pr)" }
    }

    let pid: Int32
    let appVersion: String
    let mode: String
    let engine: String
    let repos: [String]
    let phase: String
    let current: CurrentReview?
    let pending: [PendingPR]
    let lastPollAt: Date?
    let nextPollAt: Date?
    let lastError: String?
    let updatedAt: Date
}

/// `doctor --json` 결과.
struct DoctorResult: Decodable, Sendable {
    struct Check: Decodable, Sendable, Identifiable {
        let id: String
        let label: String
        let ok: Bool
        let detail: String
        let hint: String?
        let required: Bool
    }

    let checks: [Check]
    let ready: Bool

    func check(_ id: String) -> Check? { checks.first { $0.id == id } }
}

/// `repos --json`의 항목.
struct RepoItem: Decodable, Sendable, Identifiable {
    let nameWithOwner: String
    let isPrivate: Bool
    let updatedAt: String
    let selected: Bool
    var id: String { nameWithOwner }
}

/// 앱이 보여 주고 바꾸는 설정 값. 나머지 키는 CLI가 그대로 둔다.
struct ReviewerConfig: Decodable, Sendable, Equatable {
    let repos: [String]
    let pollIntervalSec: Int
    let includeDrafts: Bool
    let engine: String
    let model: String?
    let dryRun: Bool
    let stateDir: String
}

/// `config show --json` 결과.
struct ConfigSnapshot: Decodable, Sendable, Equatable {
    let path: String
    let exists: Bool
    let config: ReviewerConfig
}

/// `service status --json` 결과.
struct ServiceInfo: Decodable, Sendable, Equatable {
    let loaded: Bool
    let state: String?
    let pid: Int?
    let lastExitCode: String?
    let scriptPath: String?
    let plistPath: String
    let logPath: String
}

/// stateDir/runs.jsonl의 한 줄. v0.2.0 이하 기록에는 title·url·commentUrl이 없다.
struct RunEntry: Decodable, Sendable, Equatable, Identifiable {
    let at: Date
    let repo: String
    let pr: Int
    let title: String?
    let url: String?
    let sha: String
    let engine: String
    let dryRun: Bool
    let ok: Bool
    let durationMs: Double?
    let counts: [String: Int]?
    let posted: Bool?
    let commentUrl: String?
    let outputPath: String?
    let error: String?

    var id: String { "\(repo)#\(pr)@\(sha)@\(at.timeIntervalSince1970)" }
}

/// 설정 창에서 편집 중인 값. 저장하면 `config set`으로 넘긴다.
struct SettingsDraft: Equatable {
    var repos: Set<String> = []
    var engine = "claude"
    var model = ""
    var includeDrafts = true
    var post = false

    init(config: ReviewerConfig?) {
        guard let config else { return }
        repos = Set(config.repos)
        engine = config.engine
        model = config.model ?? ""
        includeDrafts = config.includeDrafts
        post = !config.dryRun
    }

    /// `config set` 표준 입력으로 보낼 JSON.
    func patchJSON() throws -> Data {
        let trimmedModel = model.trimmingCharacters(in: .whitespacesAndNewlines)
        let patch: [String: Any] = [
            "repos": repos.sorted(),
            "engine": engine,
            "model": trimmedModel.isEmpty ? NSNull() : trimmedModel,
            "includeDrafts": includeDrafts,
            "dryRun": !post,
        ]
        return try JSONSerialization.data(withJSONObject: patch, options: [.sortedKeys])
    }
}
