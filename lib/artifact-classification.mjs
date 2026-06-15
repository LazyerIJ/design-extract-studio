import { basename, extname } from "node:path";

const CATEGORY_LABELS = new Map([
  ["start", "Start here"],
  ["developer", "Developer"],
  ["designer", "Designer"],
  ["ai", "AI"],
  ["reports", "Reports"],
  ["images", "Images"],
  ["layout", "Layout"],
]);

function result(type, purpose, audiences, categories) {
  return {
    type,
    purpose,
    audiences,
    categories,
    categoryLabels: categories.map((category) => CATEGORY_LABELS.get(category)),
  };
}

export function classifyArtifact(path) {
  const normalized = String(path).replaceAll("\\", "/").toLowerCase();
  const name = basename(normalized);
  const extension = extname(name);

  // Layout artifacts must be matched before the generic image branch, since the
  // wireframe is an .svg the image rule would otherwise swallow.
  if (
    name.endsWith("-wireframe.svg") ||
    name.endsWith("-layout.json") ||
    name.endsWith("-layout.css") ||
    name.endsWith("-layout-skeleton.html")
  ) {
    const purpose = name.endsWith("-wireframe.svg")
      ? "페이지 섹션·컨테이너 구조를 한눈에 보는 와이어프레임입니다."
      : name.endsWith("-layout-skeleton.html")
        ? "추출한 레이아웃을 재현하는 시맨틱 HTML 스켈레톤입니다."
        : name.endsWith("-layout.css")
          ? "브레이크포인트별 grid/flex를 담은 반응형 레이아웃 CSS입니다."
          : "브레이크포인트별 레이아웃 트리(grid/flex/gap/중첩)의 원본 데이터입니다.";
    return result(
      "레이아웃",
      purpose,
      ["개발자", "디자이너", "AI"],
      ["layout", "developer", "designer"],
    );
  }

  if (
    normalized.includes("/screenshots/") ||
    normalized.startsWith("screenshots/") ||
    [".png", ".jpg", ".jpeg", ".webp", ".svg"].includes(extension)
  ) {
    return result(
      "이미지",
      "추출된 화면과 컴포넌트의 시각적 근거입니다.",
      ["디자이너", "기획자"],
      ["images", "designer"],
    );
  }
  if (name.endsWith("-design-language.md") || name === "design-language.md") {
    return result(
      "핵심 디자인 보고서",
      "색상, 글꼴, 간격, 컴포넌트와 접근성을 한 문서에서 설명합니다.",
      ["처음 보는 사람", "AI", "개발자", "디자이너"],
      ["start", "ai", "reports", "developer", "designer"],
    );
  }
  if (name.endsWith("-preview.html") || name === "preview.html") {
    return result(
      "시각 미리보기",
      "추출 결과를 브라우저에서 빠르게 둘러보는 화면입니다.",
      ["처음 보는 사람", "디자이너", "기획자"],
      ["start", "designer", "reports"],
    );
  }
  if (name.endsWith("-variables.css") || name === "variables.css") {
    return result(
      "CSS 변수",
      "색상, 글꼴, 간격과 radius를 기존 웹 프로젝트에 연결합니다.",
      ["처음 보는 사람", "프런트엔드 개발자"],
      ["start", "developer"],
    );
  }
  if (normalized.includes("/prompts/") || normalized.includes("-prompts/")) {
    return result(
      "AI 재현 프롬프트",
      "AI 제작 도구가 같은 디자인 언어를 재현하도록 전달하는 입력문입니다.",
      ["AI 사용자", "기획자", "개발자"],
      ["ai"],
    );
  }
  if (name.includes("tailwind")) {
    return result(
      "Tailwind 설정",
      "Tailwind 프로젝트에 추출 토큰과 유틸리티를 적용합니다.",
      ["프런트엔드 개발자"],
      ["developer"],
    );
  }
  if (name.includes("shadcn")) {
    return result(
      "shadcn/ui 테마",
      "shadcn/ui CSS 변수와 컴포넌트 테마를 맞춥니다.",
      ["프런트엔드 개발자"],
      ["developer"],
    );
  }
  if (name.includes("figma")) {
    return result(
      "Figma 변수",
      "Figma에서 색상과 디자인 토큰을 재구성할 때 사용합니다.",
      ["디자이너"],
      ["designer"],
    );
  }
  if (name.includes("anatomy") && extension === ".tsx") {
    return result(
      "React anatomy",
      "컴포넌트 구조와 variant 계약을 React 코드로 보여줍니다.",
      ["React 개발자", "디자인 시스템 담당자"],
      ["developer"],
    );
  }
  if (name.includes("motion")) {
    return result(
      "모션 토큰·예제",
      "duration, easing과 여러 애니메이션 구현 예제를 제공합니다.",
      ["프런트엔드 개발자", "모션 디자이너"],
      ["developer", "designer"],
    );
  }
  if (name.includes("voice")) {
    return result(
      "브랜드 문체",
      "제품 카피의 말투, 문장 스타일과 표현 기준을 설명합니다.",
      ["콘텐츠 디자이너", "AI 사용자", "마케터"],
      ["designer", "ai"],
    );
  }
  if (name.includes("design-tokens") || name.includes("tokens-shared")) {
    return result(
      "디자인 토큰",
      "도구 간에 공유할 색상, 간격, 글꼴과 효과의 구조화된 원본입니다.",
      ["개발자", "디자이너", "AI 사용자"],
      ["developer", "designer", "ai"],
    );
  }
  if (
    name.includes("accessibility") ||
    name.includes("routes-report") ||
    name.includes("stack-intel") ||
    name.includes("css-health") ||
    name.includes("form-states") ||
    name.includes("dark-mode") ||
    name.includes("seo") ||
    name === "agent.md" ||
    name.endsWith("-agent.md") ||
    name === "design.md" ||
    name.endsWith("-design.md")
  ) {
    return result(
      "진단 보고서",
      "접근성, 구현 상태 또는 기술 구성을 검토할 때 참고합니다.",
      ["기획자", "개발자", "디자이너"],
      ["reports"],
    );
  }
  if (extension === ".css") {
    return result(
      "CSS 스타일",
      "추출된 스타일이나 테마를 웹 프로젝트에 적용합니다.",
      ["프런트엔드 개발자"],
      ["developer"],
    );
  }
  if (extension === ".tsx" || extension === ".ts" || extension === ".d.ts") {
    return result(
      "TypeScript 코드",
      "타입과 컴포넌트 계약을 개발 코드에서 참고합니다.",
      ["개발자"],
      ["developer"],
    );
  }
  if (extension === ".js" || extension === ".mjs") {
    return result(
      "JavaScript 설정",
      "프레임워크나 도구에 연결할 수 있는 구현 예제입니다.",
      ["개발자"],
      ["developer"],
    );
  }
  if (extension === ".md" || extension === ".txt") {
    return result(
      "문서",
      "추출 결과와 사용 방법을 사람이 읽을 수 있게 설명합니다.",
      ["모든 사용자"],
      ["reports"],
    );
  }
  if (extension === ".json") {
    return result(
      "구조화 데이터",
      "도구나 자동화에서 읽을 수 있는 추출 데이터입니다.",
      ["개발자", "AI 사용자"],
      ["developer", "ai"],
    );
  }
  if (extension === ".html") {
    return result(
      "HTML 예제",
      "브라우저에서 열어 확인할 수 있는 생성 결과입니다.",
      ["디자이너", "개발자"],
      ["designer", "developer"],
    );
  }
  return result(
    "기타 파일",
    "추출 과정에서 생성된 보조 산출물입니다.",
    ["개발자"],
    ["developer"],
  );
}
