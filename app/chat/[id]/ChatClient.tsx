'use client';

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Character } from "../../lib/characters";

type Message = {
  from: "user" | "bot";
  text: string;
};

type ApiResponse = {
  reply?: string;
  used_web_search?: boolean;
  sources?: any[];
  error?: string;
  // (있으면 좋음) route.ts에서 추가해주면 UI에서 fallback 구분 가능
  used_openai?: boolean;
};

export default function ChatClient({ character }: { character: Character }) {
  const [messages, setMessages] = useState<Message[]>([
    { from: "bot", text: character.greeting },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const endRef = useRef<HTMLDivElement | null>(null);

  // ✅ stale state 방지용 (sendMessage에서 최신 messages 보장)
  const messagesRef = useRef<Message[]>(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // ✅ 연속 전송/중복 요청 방지(이전 요청 취소)
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function sendMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    setLoading(true);
    setError("");

    // 1) 최신 messages 기준으로 다음 배열 만들기
    const current = messagesRef.current;

    // ✅ 여기서 타입을 Message[]로 "고정" (VS Code Problems(ts2345) 해결 핵심)
    const nextMessages: Message[] = [
      ...current,
      { from: "user", text: trimmed },
    ];

    // 2) UI 즉시 반영
    setMessages(nextMessages);
    setInput("");

    // 3) 이전 요청 있으면 취소
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // 4) 서버에 “최근 맥락(기억)” 같이 보냄 (최근 12개)
      const payload = {
        message: trimmed,
        characterId: character.id,
        history: nextMessages.slice(-12),
      };

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const data: ApiResponse = await res.json().catch(() => ({} as ApiResponse));

      if (!res.ok) {
        throw new Error(data?.error || "failed to fetch reply");
      }

      const reply =
        (typeof data?.reply === "string" && data.reply.trim()) ||
        "앗… 답장을 불러오지 못했어 😵 다시 시도해볼래?";

      setMessages((prev) => [...prev, { from: "bot", text: reply }]);

      // (옵션) fallback/키 문제를 화면에 아주 약하게 표시하고 싶으면 아래 주석 해제
      // if (data.used_openai === false) {
      //   setError("지금은 AI 연결이 아니라 fallback 응답이야. (배포 env/키/로그 확인)");
      // }
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      setError(
        e?.message ||
          "메시지를 보내지 못했어요. 네트워크를 확인하고 다시 시도해주세요."
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <main
      style={{
        maxWidth: 960,
        margin: "0 auto",
        padding: 20,
        fontFamily: "system-ui",
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <header style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Link
          href="/"
          style={{
            textDecoration: "none",
            color: "#0B7A3B",
            fontWeight: 800,
            fontSize: 14,
          }}
        >
          ← 목록으로
        </Link>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: 10,
            border: "1px solid #e5e7eb",
            borderRadius: 16,
            background: "white",
            boxShadow: "0 10px 24px rgba(0,0,0,0.05)",
            flex: 1,
            minWidth: 0,
          }}
        >
          <Image
            src={character.img}
            alt={character.name}
            width={64}
            height={64}
            style={{
              width: 64,
              height: 64,
              borderRadius: 14,
              objectFit: "cover",
              border: "1px solid #eee",
              flex: "0 0 auto",
            }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 900 }}>{character.name}</div>
            <div style={{ color: "#0B7A3B", fontWeight: 800, marginTop: 2 }}>
              {character.title}
            </div>
            <div style={{ color: "#6b7280", marginTop: 4, fontSize: 13, lineHeight: 1.4 }}>
              {character.subtitle}
            </div>
          </div>
        </div>
      </header>

      <section
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 18,
          background: "white",
          boxShadow: "0 12px 28px rgba(0,0,0,0.06)",
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 12,
          flex: 1,
          minHeight: "60vh",
        }}
      >
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {character.quick.map((q) => (
            <button
              key={q}
              onClick={() => setInput(q)}
              disabled={loading}
              style={{
                border: "1px solid #e5e7eb",
                background: "#f8fafc",
                color: "#0f172a",
                borderRadius: 999,
                padding: "8px 12px",
                fontWeight: 700,
                fontSize: 13,
                cursor: loading ? "not-allowed" : "pointer",
                opacity: loading ? 0.6 : 1,
              }}
            >
              {q}
            </button>
          ))}
        </div>

        <div
          style={{
            flex: 1,
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 12,
            padding: "8px 4px",
          }}
        >
          {messages.map((m, i) => (
            <div
              key={`${m.from}-${i}-${m.text.slice(0, 10)}`}
              style={{
                alignSelf: m.from === "user" ? "flex-end" : "flex-start",
                maxWidth: "82%",
                background: m.from === "user" ? "#0B7A3B" : "#f1f5f9",
                color: m.from === "user" ? "white" : "#0f172a",
                borderRadius: 14,
                padding: "10px 12px",
                whiteSpace: "pre-wrap",
                lineHeight: 1.5,
                boxShadow: "0 8px 18px rgba(0,0,0,0.05)",
              }}
            >
              {m.text}
            </div>
          ))}
          <div ref={endRef} />
        </div>

        {error && (
          <div
            style={{
              color: "#b91c1c",
              background: "#fef2f2",
              border: "1px solid #fecaca",
              borderRadius: 12,
              padding: "8px 12px",
              fontSize: 13,
            }}
          >
            {error}
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            sendMessage(input);
          }}
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
          }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="메시지를 입력하세요"
            disabled={loading}
            style={{
              flex: 1,
              borderRadius: 12,
              border: "1px solid #e5e7eb",
              padding: "12px 14px",
              fontSize: 14,
              outline: "none",
              boxShadow: "0 4px 10px rgba(0,0,0,0.04)",
              opacity: loading ? 0.7 : 1,
            }}
          />
          <button
            type="submit"
            disabled={loading}
            style={{
              background: loading ? "#9ca3af" : "#0B7A3B",
              color: "white",
              border: "none",
              borderRadius: 12,
              padding: "12px 16px",
              fontWeight: 800,
              cursor: loading ? "not-allowed" : "pointer",
              minWidth: 82,
              boxShadow: "0 8px 16px rgba(0,0,0,0.08)",
            }}
          >
            {loading ? "전송중…" : "보내기"}
          </button>
        </form>
      </section>
    </main>
  );
}
