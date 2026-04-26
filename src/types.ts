export type SkillDoc = {
  path: string;
  title: string;
  url: string;
  content: string;
};

export type SearchHit = {
  path: string;
  title: string;
  heading: string;
  excerpt: string;
  score: number;
  url: string;
};

export type SkillState =
  | { status: "loading"; docs: SkillDoc[]; message: string }
  | { status: "ready"; docs: SkillDoc[]; message: string }
  | { status: "error"; docs: SkillDoc[]; message: string };

export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
};

export type ActivityKind = "skill" | "thinking" | "tool" | "answer" | "error";

export type ActivityItem = {
  id: string;
  kind: ActivityKind;
  title: string;
  body?: string;
  createdAt: number;
};

export type AppSettings = {
  apiKey: string;
  model: string;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high";
};
