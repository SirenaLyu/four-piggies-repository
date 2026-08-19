"use client";

import { useEffect, useRef, useState } from "react";
import { IntroAnimation } from "./IntroAnimation";
import { Logo } from "./Logo";
import "./LandingPage.css";

/** 搜索框轮播的校园问题 */
const QUESTIONS = [
  "饭卡如何充值？",
  "宿舍水电费怎么查？",
  "校车几点发车？",
  "怎么预约图书馆研讨间？",
  "选课系统几点开放？",
];

/** 线性图标（Lucide 风格，描边用 currentColor） */
const ICONS = {
  chat: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  ),
  calendar: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="17" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  ),
  book: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
    </svg>
  ),
  bell: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  ),
  users: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  messageSquare: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  ),
  user: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  ),
} as const;

type IconName = keyof typeof ICONS;

/** 功能板块（bento 布局） */
const FEATURES: { icon: IconName; title: string; desc: string; tag: string; cls: string }[] = [
  { icon: "chat", title: "校园问答", desc: "食堂、选课、宿舍、社团——任何校园问题，直接问，秒回答案。这是你最常用的入口。", tag: "问答", cls: "lg" },
  { icon: "calendar", title: "课表查询", desc: "本周课程、调课提醒、考试安排，一目了然。", tag: "教务", cls: "tall" },
  { icon: "book", title: "图书馆", desc: "座位余量、开放时间、馆藏检索。", tag: "学习", cls: "" },
  { icon: "bell", title: "校园通知", desc: "教务处、学院最新公告。", tag: "通知", cls: "" },
  { icon: "users", title: "学习讨论", desc: "和同学交流心得、答疑解惑，也能整理你自己的笔记资料。", tag: "社区", cls: "wide" },
];

/**
 * 清新校园风落地页：开场动画 → 品牌 Hero（问题轮播搜索框 + 对话演示）→ 功能便签 → 进入对话。
 */
export function LandingPage({ onEnter }: { onEnter: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [ghost, setGhost] = useState("");

  // 搜索框问题打字轮播
  useEffect(() => {
    let qi = 0;
    let ci = 0;
    let deleting = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = () => {
      const word = QUESTIONS[qi];
      if (!deleting) {
        ci += 1;
        setGhost(word.slice(0, ci));
        if (ci === word.length) {
          deleting = true;
          timer = setTimeout(tick, 1600);
          return;
        }
        timer = setTimeout(tick, 65);
      } else {
        ci -= 1;
        setGhost(word.slice(0, ci));
        if (ci === 0) {
          deleting = false;
          qi = (qi + 1) % QUESTIONS.length;
          timer = setTimeout(tick, 350);
          return;
        }
        timer = setTimeout(tick, 28);
      }
    };

    tick();
    return () => clearTimeout(timer);
  }, []);

  // 滚动显现：滚入视野淡入，滚出视野淡出，反复生效
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("fl-reveal-in");
          } else {
            entry.target.classList.remove("fl-reveal-in");
          }
        });
      },
      { threshold: 0.12 }
    );
    root.querySelectorAll(".fl-reveal").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  return (
    <div ref={rootRef} className="fresh-landing">
      {/* 第一屏：开场动画 */}
      <section className="fl-intro">
        <IntroAnimation onFinish={() => rootRef.current?.scrollTo({ top: window.innerHeight, behavior: "smooth" })} />
      </section>

      {/* 过渡：天空蓝 → 纯色灰，衔接更自然 */}
      <div className="fl-bridge" aria-hidden="true" />

      {/* 导航 */}
      <nav className="fl-nav">
        <div className="fl-brand">
          <Logo size={32} color="#3e63af" accent="#e68947" />
          科大精灵
        </div>
      </nav>

      {/* Hero */}
      <section className="fl-hero">
        <div className="fl-reveal">
          <div className="fl-eyebrow">USTC · 校园智能问答</div>
          <h1>
            校园里的问题，
            <br />
            在这里被<em>回答</em>
          </h1>
          <p className="fl-sub">课程、食堂、图书馆、社团——想问什么，直接问。</p>

          <div className="fl-search" onClick={onEnter} role="button" tabIndex={0}>
            <span className="fl-ghost">
              {ghost}
              <span className="fl-caret" />
            </span>
            <span className="fl-search-btn">搜索</span>
          </div>
          <p className="fl-hint">试试问：饭卡如何充值？</p>
        </div>

        <div className="fl-visual fl-reveal">
          <div className="fl-chat">
            <div className="fl-chat-head">
              <span className="dot" />
              科大精灵 · 正在对话
            </div>
            <div className="fl-msg user">
              饭卡怎么充值？
              <span className="m-time">12:08</span>
            </div>
            <div className="fl-msg ai">
              可以去食堂圈存机刷银行卡充值，或微信搜索「校园卡服务」绑定学号后线上充值，两分钟到账。
              <span className="m-time">12:08</span>
            </div>
            <div className="fl-typing">
              <span />
              <span />
              <span />
            </div>
          </div>
        </div>
      </section>

      {/* 波浪分隔 */}
      <div className="fl-wave">
        <svg viewBox="0 0 1440 60" preserveAspectRatio="none" aria-hidden="true">
          <path d="M0,30 C240,70 480,0 720,30 C960,60 1200,10 1440,40 L1440,60 L0,60 Z" fill="#e9eef8" />
        </svg>
      </div>

      {/* 功能便签 */}
      <section className="fl-features">
        <div className="fl-section-head">
          <h2>它能帮你做什么</h2>
          <p>你最常用的几个入口</p>
        </div>
        <div className="fl-bento">
          {FEATURES.map((f) => (
            <div key={f.title} className={`fl-card ${f.cls} fl-reveal`}>
              <div className="fl-c-icon">{ICONS[f.icon]}</div>
              <div>
                <h3>{f.title}</h3>
                <p>{f.desc}</p>
              </div>
              <span className="fl-tag">{f.tag}</span>
            </div>
          ))}

          {/* 讨论对话框 */}
          <div className="fl-card discuss fl-reveal">
            <div className="fl-c-icon">{ICONS.messageSquare}</div>
            <h3>同学们在聊</h3>
            <div className="fl-discuss-msgs">
              <div className="fl-discuss-msg">
                <span className="avatar" style={{ background: "#e9eef8" }}>
                  {ICONS.user}
                </span>
                <div className="bubble">高数期末的重点有整理好的吗？</div>
              </div>
              <div className="fl-discuss-msg me">
                <div className="bubble">有呀，3 楼置顶帖里，直接看就行。</div>
                <span className="avatar" style={{ background: "#fdf1e5" }}>
                  {ICONS.user}
                </span>
              </div>
            </div>
            <div className="fl-discuss-input">
              <span>说点什么…</span>
              <button type="button" onClick={onEnter}>
                发送
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="fl-cta">
        <div className="fl-cta-inner fl-reveal">
          <h2>准备好提问了吗？</h2>
          <p>进入对话，问出你的第一个校园问题</p>
          <button className="fl-btn" onClick={onEnter}>
            立即进入 →
          </button>
        </div>
      </section>
    </div>
  );
}
