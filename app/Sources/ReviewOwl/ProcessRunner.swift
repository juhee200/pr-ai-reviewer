import Foundation
import os

/// 외부 명령의 실행 결과.
struct ProcessOutput: Sendable {
    let status: Int32
    let stdout: Data
    let stderr: Data
    let timedOut: Bool

    var stdoutText: String { String(decoding: stdout, as: UTF8.self) }
    var stderrText: String { String(decoding: stderr, as: UTF8.self) }
}

/// Process는 Sendable이 아니지만 terminate와 종료 상태 조회는 다른 스레드에서 불러도 된다.
private final class ProcessHandle: @unchecked Sendable {
    let process = Process()
}

private final class OutputCollector: Sendable {
    private struct Buffers: Sendable {
        var stdout = Data()
        var stderr = Data()
        var timedOut = false
    }

    private let buffers = OSAllocatedUnfairLock(initialState: Buffers())

    func append(_ chunk: Data, toStdout: Bool) {
        buffers.withLock { toStdout ? $0.stdout.append(chunk) : $0.stderr.append(chunk) }
    }

    func markTimedOut() {
        buffers.withLock { $0.timedOut = true }
    }

    func output(status: Int32) -> ProcessOutput {
        buffers.withLock { ProcessOutput(status: status, stdout: $0.stdout, stderr: $0.stderr, timedOut: $0.timedOut) }
    }
}

/// 셸을 거치지 않고 인자 배열로 실행한다. 표준 출력·오류를 끝까지 읽고 종료를 기다린 뒤 결과를 돌려준다.
/// 제한 시간이 지나면 프로세스를 종료하고 timedOut을 표시한다.
func runProcess(
    _ executable: URL,
    _ arguments: [String],
    environment: [String: String]? = nil,
    input: Data? = nil,
    timeout: Duration = .seconds(120)
) async throws -> ProcessOutput {
    let handle = ProcessHandle()
    let process = handle.process
    process.executableURL = executable
    process.arguments = arguments
    if let environment { process.environment = environment }

    let stdoutPipe = Pipe()
    let stderrPipe = Pipe()
    let stdinPipe: Pipe? = input == nil ? nil : Pipe()
    process.standardOutput = stdoutPipe
    process.standardError = stderrPipe
    if let stdinPipe {
        process.standardInput = stdinPipe
    } else {
        process.standardInput = FileHandle.nullDevice
    }

    let collector = OutputCollector()
    // 표준 출력 EOF, 표준 오류 EOF, 프로세스 종료 세 가지를 모두 기다린다.
    let group = DispatchGroup()
    group.enter()
    group.enter()
    group.enter()
    stdoutPipe.fileHandleForReading.readabilityHandler = { file in
        let chunk = file.availableData
        if chunk.isEmpty {
            file.readabilityHandler = nil
            group.leave()
        } else {
            collector.append(chunk, toStdout: true)
        }
    }
    stderrPipe.fileHandleForReading.readabilityHandler = { file in
        let chunk = file.availableData
        if chunk.isEmpty {
            file.readabilityHandler = nil
            group.leave()
        } else {
            collector.append(chunk, toStdout: false)
        }
    }
    process.terminationHandler = { _ in group.leave() }

    do {
        try process.run()
    } catch {
        stdoutPipe.fileHandleForReading.readabilityHandler = nil
        stderrPipe.fileHandleForReading.readabilityHandler = nil
        group.leave()
        group.leave()
        group.leave()
        throw error
    }
    if let input, let stdinPipe {
        try? stdinPipe.fileHandleForWriting.write(contentsOf: input)
        try? stdinPipe.fileHandleForWriting.close()
    }

    let timer = Task {
        try await Task.sleep(for: timeout)
        collector.markTimedOut()
        handle.process.terminate()
    }
    return await withCheckedContinuation { continuation in
        group.notify(queue: .global()) {
            timer.cancel()
            continuation.resume(returning: collector.output(status: handle.process.terminationStatus))
        }
    }
}
