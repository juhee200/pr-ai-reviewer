import Foundation

enum CLIError: LocalizedError {
    case nodeNotFound
    case scriptNotFound(String)
    case failed(String)
    case timedOut
    case invalidOutput(String)

    var errorDescription: String? {
        switch self {
        case .nodeNotFound: "Node.js를 찾지 못했습니다. 터미널에서 brew install node를 실행한 뒤 앱을 다시 여세요."
        case .scriptNotFound(let path): "앱 안의 CLI 파일이 없습니다: \(path)"
        case .failed(let message): message
        case .timedOut: "명령이 제한 시간 안에 끝나지 않았습니다."
        case .invalidOutput(let command): "\(command) 결과를 해석하지 못했습니다."
        }
    }
}

/// 앱 번들에 넣은 pr-ai-reviewer CLI를 시스템 node로 실행한다.
/// 앱은 화면과 제어만 맡고, 설정 검증·저장·자동 실행 등록·리뷰는 CLI가 한다.
struct CLI: Sendable {
    let nodeURL: URL
    let scriptURL: URL
    let environment: [String: String]

    static func locate() async throws -> CLI {
        let script = try bundledScript()
        let path = await composedPath()
        guard let node = await findNode(in: path) else { throw CLIError.nodeNotFound }
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = path.joined(separator: ":")
        return CLI(nodeURL: node, scriptURL: script, environment: environment)
    }

    private static func bundledScript() throws -> URL {
        // 개발 중에는 PR_AI_REVIEWER_CLI로 저장소의 dist/cli.js를 가리킬 수 있다.
        if let override = ProcessInfo.processInfo.environment["PR_AI_REVIEWER_CLI"], !override.isEmpty {
            return URL(fileURLWithPath: override)
        }
        guard let resources = Bundle.main.resourceURL else { throw CLIError.scriptNotFound("Contents/Resources") }
        let script = resources.appendingPathComponent("cli/dist/cli.js")
        guard FileManager.default.fileExists(atPath: script.path) else { throw CLIError.scriptNotFound(script.path) }
        return script
    }

    /// Finder나 로그인 항목으로 실행하면 PATH가 /usr/bin:/bin 정도뿐이다.
    /// 로그인 셸의 PATH에 Homebrew와 ~/.local/bin 경로를 더해 node, gh, claude, codex를 찾게 한다.
    private static func composedPath() async -> [String] {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let entries = await loginShellPath() + [
            "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "\(home)/.local/bin",
            "/usr/bin", "/bin", "/usr/sbin", "/sbin",
        ]
        var seen = Set<String>()
        return entries.filter { $0.hasPrefix("/") && seen.insert($0).inserted }
    }

    private static func loginShellPath() async -> [String] {
        guard let shell = userShell() else { return [] }
        let marker = "__PR_AI_REVIEWER_PATH__"
        // -i로 .zshrc까지 읽어 nvm 등이 더한 경로도 얻는다. 셸 설정의 다른 출력과 섞이지 않게 표식 사이 값만 쓴다.
        let command = "printf '\(marker)%s\(marker)' \"$PATH\""
        guard let output = try? await runProcess(URL(fileURLWithPath: shell), ["-l", "-i", "-c", command], timeout: .seconds(5)),
              !output.timedOut
        else { return [] }
        let parts = output.stdoutText.components(separatedBy: marker)
        guard parts.count >= 3 else { return [] }
        return parts[1].split(separator: ":").map(String.init)
    }

    private static func userShell() -> String? {
        guard let entry = getpwuid(getuid()), let shell = entry.pointee.pw_shell else { return nil }
        let path = String(cString: shell)
        return FileManager.default.isExecutableFile(atPath: path) ? path : nil
    }

    /// PATH 순서대로 node를 찾되, nvm 기본 버전처럼 22 미만이면 건너뛴다. 맞는 버전이 없으면 처음 찾은 node를 써서
    /// 환경 점검 화면이 버전 문제를 알려 주게 한다.
    private static func findNode(in path: [String]) async -> URL? {
        var candidates: [URL] = []
        var seen = Set<String>()
        for dir in path {
            let candidate = URL(fileURLWithPath: dir).appendingPathComponent("node")
            guard FileManager.default.isExecutableFile(atPath: candidate.path),
                  seen.insert(candidate.resolvingSymlinksInPath().path).inserted
            else { continue }
            candidates.append(candidate)
        }
        for candidate in candidates {
            guard let output = try? await runProcess(candidate, ["--version"], timeout: .seconds(5)), output.status == 0 else { continue }
            let major = output.stdoutText.trimmingCharacters(in: .whitespacesAndNewlines)
                .dropFirst()
                .split(separator: ".")
                .first
                .flatMap { Int($0) }
            if let major, major >= 22 { return candidate }
        }
        return candidates.first
    }

    /// 종료 코드가 0이 아니면 CLI가 남긴 오류 문구로 실패를 던진다.
    @discardableResult
    func run(_ arguments: [String], input: Data? = nil, timeout: Duration = .seconds(120)) async throws -> ProcessOutput {
        let output = try await runProcess(nodeURL, [scriptURL.path] + arguments, environment: environment, input: input, timeout: timeout)
        if output.timedOut { throw CLIError.timedOut }
        if output.status != 0 { throw CLIError.failed(Self.errorMessage(from: output)) }
        return output
    }

    func decode<T: Decodable>(_ type: T.Type, _ arguments: [String], timeout: Duration = .seconds(120)) async throws -> T {
        let output = try await run(arguments, timeout: timeout)
        do {
            return try makeDecoder().decode(T.self, from: output.stdout)
        } catch {
            throw CLIError.invalidOutput(arguments.prefix(2).joined(separator: " "))
        }
    }

    /// CLI는 "[시:분:초] 오류: 메시지"를 stderr에 남긴다. 메시지가 여러 줄일 수 있어 마지막 오류 줄부터 끝까지 쓴다.
    static func errorMessage(from output: ProcessOutput) -> String {
        let lines = output.stderrText.split(separator: "\n").map(String.init)
        let marker = "] 오류: "
        if let index = lines.lastIndex(where: { $0.contains(marker) }), let range = lines[index].range(of: marker) {
            return ([String(lines[index][range.upperBound...])] + lines[(index + 1)...]).joined(separator: "\n")
        }
        return lines.last ?? "명령이 실패했습니다 (종료 코드 \(output.status))."
    }
}
