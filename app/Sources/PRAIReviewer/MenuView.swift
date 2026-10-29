import SwiftUI

/// 메뉴바 아이콘을 누르면 보이는 창.
struct MenuView: View {
    let model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            statusSection
            if model.daemonRunning, let current = model.status?.current {
                currentSection(current)
            }
            if model.daemonRunning, let pending = model.status?.pending, !pending.isEmpty {
                pendingSection(pending)
            }
            Divider()
            recentSection
            Divider()
            controls
        }
        .padding(14)
        .frame(width: 360)
        .task { await model.refreshService() }
    }

    private var header: some View {
        HStack {
            Text("PR AI Reviewer").font(.headline)
            Spacer()
            Button {
                model.openSettings()
            } label: {
                Image(systemName: "gearshape")
            }
            .buttonStyle(.borderless)
            .help("설정")
        }
    }

    @ViewBuilder
    private var statusSection: some View {
        if let setupError = model.setupError {
            Label(setupError, systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)
                .fixedSize(horizontal: false, vertical: true)
        } else if !model.daemonRunning {
            VStack(alignment: .leading, spacing: 6) {
                Label("자동 리뷰가 실행 중이 아닙니다", systemImage: "moon.zzz")
                Text(model.isAutoReviewOn ? "등록은 돼 있지만 감시 상태를 읽을 수 없습니다. 설정에서 다시 등록하거나 로그를 확인하세요." : "설정에서 저장소를 고르고 자동 리뷰를 켜세요.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button("설정 열기") { model.openSettings() }
            }
        } else if let status = model.status {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Circle().fill(phaseColor(status)).frame(width: 8, height: 8)
                    Text(phaseText(status.phase)).font(.subheadline.weight(.semibold))
                }
                Text("\(status.mode == "post" ? "PR에 게시" : "dry-run (게시 안 함)") · \(status.engine) · 저장소 \(status.repos.count)개")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if status.phase == "waiting", let next = status.nextPollAt {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Text("다음 조회까지 \(countdown(to: next, now: context.date))")
                            .font(.caption)
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                    }
                }
                if let error = status.lastError {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func currentSection(_ current: DaemonStatus.CurrentReview) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("리뷰 중").font(.caption).foregroundStyle(.secondary)
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                VStack(alignment: .leading, spacing: 1) {
                    Text(current.title).lineLimit(1)
                    Text("\(current.repo)#\(current.pr) · \(current.sha.prefix(7))")
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 4)
                Text(current.startedAt, style: .timer)
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func pendingSection(_ pending: [DaemonStatus.PendingPR]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("대기 중 \(pending.count)건").font(.caption).foregroundStyle(.secondary)
            ForEach(pending.prefix(3)) { item in
                Button {
                    model.openGitHub(item.url)
                } label: {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(item.title).lineLimit(1)
                        Text("\(item.repo)#\(item.pr)\(item.isDraft ? " · Draft" : "") · \(item.reason)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var recentSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("최근 리뷰").font(.caption).foregroundStyle(.secondary)
            if model.recentRuns.isEmpty {
                Text("아직 리뷰 기록이 없습니다.").font(.caption).foregroundStyle(.secondary)
            }
            ForEach(model.recentRuns.prefix(5)) { run in
                RunRow(run: run, model: model)
            }
        }
    }

    private var controls: some View {
        HStack(spacing: 8) {
            Group {
                if model.status?.phase == "paused" {
                    Button("재개") { Task { await model.control("resume") } }
                } else {
                    Button("일시정지") { Task { await model.control("pause") } }
                }
                Button("지금 조회") { Task { await model.control("poll-now") } }
                    .disabled(model.status?.phase == "paused")
            }
            .disabled(model.cli == nil || !model.daemonRunning)
            Spacer()
            // 종료는 CLI를 못 찾았을 때도 눌러야 하므로 비활성화하지 않는다.
            Button("종료") { NSApp.terminate(nil) }
                .help("메뉴바 앱만 종료합니다. 자동 리뷰는 계속 동작합니다.")
        }
        .controlSize(.small)
    }

    private func phaseText(_ phase: String) -> String {
        switch phase {
        case "starting": "시작 중"
        case "polling": "PR 조회 중"
        case "reviewing": "리뷰 중"
        case "waiting": "감시 중"
        case "paused": "일시정지됨"
        case "stopped": "중지됨"
        default: phase
        }
    }

    private func phaseColor(_ status: DaemonStatus) -> Color {
        if status.lastError != nil { return .orange }
        switch status.phase {
        case "paused": return .gray
        case "reviewing", "polling": return .blue
        default: return .green
        }
    }

    private func countdown(to date: Date, now: Date) -> String {
        let seconds = max(0, Int(date.timeIntervalSince(now).rounded(.up)))
        return seconds >= 60 ? "\(seconds / 60)분 \(seconds % 60)초" : "\(seconds)초"
    }
}

/// 최근 리뷰 한 건. PR, 게시한 코멘트, 로컬 리뷰 파일을 열 수 있다.
private struct RunRow: View {
    let run: RunEntry
    let model: AppModel

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: icon)
                .foregroundStyle(run.ok ? Color.accentColor : .red)
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 1) {
                Text(run.title ?? "\(run.repo)#\(run.pr)").lineLimit(1).truncationMode(.middle)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(run.ok ? Color.secondary : .red)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            HStack(spacing: 2) {
                if let address = model.pullRequestAddress(repo: run.repo, pr: run.pr, url: run.url) {
                    linkButton("arrow.up.right.square", help: "PR 열기") { model.openGitHub(address) }
                }
                if let comment = run.commentUrl {
                    linkButton("text.bubble", help: "리뷰 코멘트 열기") { model.openGitHub(comment) }
                }
                if run.outputPath != nil {
                    linkButton("doc.text", help: "이 PC에 저장한 리뷰 열기") { model.openReviewFile(run.outputPath) }
                }
            }
        }
    }

    private var icon: String {
        guard run.ok else { return "xmark.octagon" }
        return run.posted == true ? "checkmark.bubble" : "doc.text.magnifyingglass"
    }

    private var subtitle: String {
        let time = Calendar.current.isDateInToday(run.at)
            ? run.at.formatted(date: .omitted, time: .shortened)
            : run.at.formatted(.dateTime.month(.defaultDigits).day().hour().minute())
        // 제목이 없는 이전 기록은 제목 자리에 저장소#번호를 보여 주므로 번호를 반복하지 않는다.
        let number = run.title == nil ? [] : ["#\(run.pr)"]
        guard run.ok else { return (number + ["실패", time]).joined(separator: " · ") }
        let counts = ["P0", "P1", "P2", "P3"].compactMap { key -> String? in
            guard let count = run.counts?[key], count > 0 else { return nil }
            return "\(key) \(count)"
        }
        let summary = counts.isEmpty ? "지적 없음" : counts.joined(separator: " · ")
        return (number + [summary, run.posted == true ? "게시" : "저장만", time]).joined(separator: " · ")
    }

    private func linkButton(_ symbol: String, help: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
        }
        .buttonStyle(.borderless)
        .help(help)
    }
}
