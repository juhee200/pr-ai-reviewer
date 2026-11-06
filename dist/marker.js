// PR 코멘트에 숨겨 두는 표식. 어느 커밋을 어떤 엔진으로 리뷰했는지 기록해 중복 리뷰를 막는다.
// 이름을 리뷰엉이(review-owl)로 바꾼 뒤에도 표식은 바꾸지 않는다. 바꾸면 이미 리뷰한 커밋을 알아보지 못해 다시 리뷰한다.
const MARKER_PATTERN = /<!-- pr-ai-reviewer:v1 sha=([0-9a-f]{40}) engine=([a-z]+) -->/g;
export function buildMarker(sha, engine) {
    return `<!-- pr-ai-reviewer:v1 sha=${sha} engine=${engine} -->`;
}
export function bodyHasMarkerFor(text, sha) {
    for (const match of text.matchAll(MARKER_PATTERN)) {
        if (match[1] === sha)
            return true;
    }
    return false;
}
