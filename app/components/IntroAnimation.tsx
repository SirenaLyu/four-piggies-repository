"use client";

import { useEffect, useRef } from "react";
import "./IntroAnimation.css";

/**
 * 开场动画：白昼平地起校门 → 日夜渐变 → 流星 → Logo → 「科大精灵」
 * 播放约 5.6 秒后调用 onFinish，由父组件切换到主界面。
 */
export function IntroAnimation({ onFinish }: { onFinish: () => void }) {
  const onFinishRef = useRef(onFinish);
  useEffect(() => {
    onFinishRef.current = onFinish;
  });

  useEffect(() => {
    const timer = setTimeout(() => onFinishRef.current(), 5600);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="intro-stage">
      <svg viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" fill="none">
        <defs>
          <linearGradient id="dayGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#eaf4ff" />
            <stop offset="1" stopColor="#cfe4ff" />
          </linearGradient>
          <linearGradient id="nightGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#0b1220" />
            <stop offset="1" stopColor="#17233f" />
          </linearGradient>
          <linearGradient id="meteorGrad" x1="1" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#ffffff" stopOpacity="0" />
            <stop offset="1" stopColor="#ffffff" />
          </linearGradient>
        </defs>
        <g className="camera">
          {/* 白昼天空 */}
          <rect x="0" y="0" width="400" height="300" fill="url(#dayGrad)" />
          <image className="blur-bg" href="/01.jpg" x="0" y="0" width="400" height="300" preserveAspectRatio="xMidYMid slice" />
          <g className="sun">
            <circle cx="330" cy="78" r="24" fill="#f5b41a" />
            <circle className="sun-halo" cx="330" cy="78" r="34" fill="#f5b41a" opacity=".18" />
          </g>
          {/* 白天飞鸟 */}
          <g className="bird" stroke="#33415c" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
            <path d="M40 90 Q45 84 50 90 Q55 84 60 90" />
          </g>
          <g className="bird b2" stroke="#33415c" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
            <path d="M120 110 Q124 105 128 110 Q132 105 136 110" />
          </g>
          <g className="bird b3" stroke="#33415c" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
            <path d="M90 70 Q93 65 96 70 Q99 65 102 70" />
          </g>

          {/* 夜空层 */}
          <g className="sky-night">
            <rect x="0" y="0" width="400" height="300" fill="url(#nightGrad)" />
            <image className="blur-bg" href="/02.jpg" x="0" y="0" width="400" height="300" preserveAspectRatio="xMidYMid slice" />
            <g className="moon">
              <g className="moon-float">
                <path d="M338 78 A18 18 0 1 1 322 78 A13 13 0 1 0 338 78 Z" fill="#e8eef7" transform="rotate(45 330 78) translate(3 -18)" />
                <circle className="moon-halo" cx="330" cy="78" r="27" fill="#e8eef7" opacity=".12" />
                <g fill="#dfe9f7">
                  <circle className="silver" cx="330" cy="52" r="1.4" style={{ animationDelay: "0s" }} />
                  <circle className="silver" cx="308" cy="64" r="1.1" style={{ animationDelay: ".4s" }} />
                  <circle className="silver" cx="352" cy="64" r="1.1" style={{ animationDelay: ".8s" }} />
                  <circle className="silver" cx="302" cy="82" r="1.3" style={{ animationDelay: "1.2s" }} />
                  <circle className="silver" cx="358" cy="82" r="1.0" style={{ animationDelay: ".2s" }} />
                  <circle className="silver" cx="316" cy="98" r="1.2" style={{ animationDelay: ".6s" }} />
                  <circle className="silver" cx="344" cy="98" r="1.0" style={{ animationDelay: "1.0s" }} />
                </g>
                <g fill="#dfe9f7">
                  <circle className="silver-fall" cx="326" cy="100" r="1.1" style={{ animationDelay: "0s" }} />
                  <circle className="silver-fall" cx="336" cy="104" r="0.9" style={{ animationDelay: ".8s" }} />
                  <circle className="silver-fall" cx="330" cy="108" r="1.0" style={{ animationDelay: "1.6s" }} />
                </g>
              </g>
            </g>
            <g className="star"><circle cx="40" cy="60" r="2" fill="#fff" /></g>
            <g className="star"><circle cx="90" cy="90" r="1.5" fill="#fff" /></g>
            <g className="star"><circle cx="150" cy="50" r="2" fill="#fff" /></g>
            <g className="star"><circle cx="210" cy="75" r="1.5" fill="#fff" /></g>
            <g className="star"><circle cx="270" cy="58" r="2" fill="#fff" /></g>
            <g className="star"><circle cx="60" cy="130" r="1.5" fill="#fff" /></g>
            <g className="star"><circle cx="120" cy="110" r="1.2" fill="#fff" /></g>
            <g className="star"><circle cx="180" cy="140" r="1.2" fill="#fff" /></g>
            <g className="star"><circle cx="360" cy="130" r="1.5" fill="#fff" /></g>
            <g className="star"><circle cx="310" cy="110" r="1.2" fill="#fff" /></g>

            <g className="night-ambient" stroke="#a9bcd8" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M52 259 V238" />
              <path d="M44 230 Q52 220 60 230" />
              <path d="M42 234 Q52 225 62 234" />
              <path d="M348 259 V238" />
              <path d="M340 230 Q348 220 356 230" />
              <path d="M338 234 Q348 225 358 234" />
              <path d="M34 259 V226" />
              <path d="M28 226 H40" />
              <circle cx="34" cy="223" r="2.5" />
              <path d="M366 259 V226" />
              <path d="M360 226 H372" />
              <circle cx="366" cy="223" r="2.5" />
            </g>
            <g className="lamp-glow" fill="#ffe9b0">
              <circle cx="34" cy="220" r="9" />
              <circle cx="366" cy="220" r="9" />
            </g>

            <g className="meteor"><line x1="300" y1="40" x2="250" y2="70" stroke="url(#meteorGrad)" strokeWidth="3" strokeLinecap="round" /></g>
            <g className="meteor m2"><line x1="360" y1="70" x2="310" y2="100" stroke="url(#meteorGrad)" strokeWidth="2.5" strokeLinecap="round" /></g>
            <g className="meteor-final"><line x1="290" y1="30" x2="255" y2="50" stroke="#fff" strokeWidth="3" strokeLinecap="round" /></g>
          </g>

          {/* 地面 */}
          <line className="ground-line" x1="0" y1="259" x2="400" y2="259" stroke="#16233a" strokeWidth="2.5" strokeLinecap="round" />

          {/* 校门（三开牌坊，USTC 居中） */}
          <g className="buildings-near" stroke="#ffffff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M172 145 H228" />
            <path d="M108 153 H292" />
            <path d="M108 175 H292" />
            <path d="M108 175 V259" />
            <path d="M150 175 V259" />
            <path d="M250 175 V259" />
            <path d="M292 175 V259" />
            <path d="M108 259 V200 H150 V259" />
            <path d="M250 259 V200 H292 V259" />
            <path d="M150 259 A50 79 0 0 1 250 259" />
            <text x="200" y="167" textAnchor="middle" fontFamily="Verdana, Geneva, sans-serif" fontSize="13" fontWeight="400" fill="#ffffff" letterSpacing="1.5">USTC</text>
          </g>

          {/* Logo（最后阶段） */}
          <g className="logo-group">
            <g transform="translate(200 140)">
              <g className="orbit">
                <ellipse cx="0" cy="5" rx="30" ry="13" transform="rotate(-16 0 5)" stroke="#0046AD" strokeWidth="3" strokeLinecap="round" />
                <circle cx="23" cy="-4" r="2.5" fill="#ffffff" />
              </g>
              <path d="M0 -6 C-5 -9 -10 -7 -12 -4 L-12 7 C-8 5 -4 7 0 10" stroke="#0046AD" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M0 -6 C5 -9 10 -7 12 -4 L12 7 C8 5 4 7 0 10" stroke="#0046AD" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M0 -6 V10" stroke="#0046AD" strokeWidth="3" strokeLinecap="round" />
              <path className="sparkle" d="M-36 -26 L-34.5 -21.5 L-30 -20 L-34.5 -18.5 L-36 -14 L-37.5 -18.5 L-42 -20 L-37.5 -21.5 Z" fill="#ffffff" style={{ animationDelay: "0s" }} />
              <path className="sparkle" d="M36 -24 L37.5 -19.5 L42 -18 L37.5 -16.5 L36 -12 L34.5 -16.5 L30 -18 L34.5 -19.5 Z" fill="#ffffff" style={{ animationDelay: ".6s" }} />
              <path className="sparkle" d="M0 21 L1.5 25.5 L6 27 L1.5 28.5 L0 33 L-1.5 28.5 L-6 27 L-1.5 25.5 Z" fill="#ffffff" style={{ animationDelay: "1.2s" }} />
            </g>
          </g>

          {/* 标题「科大精灵」（逐字浮现） */}
          <g className="title-group">
            <text className="char" x="149" y="84" textAnchor="middle" fontFamily="华文琥珀, STHupo, sans-serif" fontSize="30" fill="#0046AD" style={{ animationDelay: "4.5s" }}>科</text>
            <text className="char" x="183" y="84" textAnchor="middle" fontFamily="华文琥珀, STHupo, sans-serif" fontSize="30" fill="#0046AD" style={{ animationDelay: "4.65s" }}>大</text>
            <text className="char" x="217" y="84" textAnchor="middle" fontFamily="华文琥珀, STHupo, sans-serif" fontSize="30" fill="#0046AD" style={{ animationDelay: "4.8s" }}>精</text>
            <text className="char" x="251" y="84" textAnchor="middle" fontFamily="华文琥珀, STHupo, sans-serif" fontSize="30" fill="#0046AD" style={{ animationDelay: "4.95s" }}>灵</text>
            <path className="sparkle" d="M130 53 L131.2 56.2 L135 58 L131.2 59.8 L130 63 L128.8 59.8 L125 58 L128.8 56.2 Z" fill="#ffffff" style={{ animationDelay: "5.1s" }} />
            <path className="sparkle" d="M270 53 L271.2 56.2 L275 58 L271.2 59.8 L270 63 L268.8 59.8 L265 58 L268.8 56.2 Z" fill="#ffffff" style={{ animationDelay: "5.1s" }} />
          </g>
        </g>
      </svg>
    </div>
  );
}
