/**
 * 硬编码兜底字幕。
 *
 * 当真实抓取（直连 + 代理）都失败、且视频为演示视频时回落到此，
 * 保证演示链路始终可跑通（需求文档建议）。
 *
 * 内容为演示视频 xRh2sVcNXQ8（a16z 关于 AI 的访谈）的字幕节选/整理，
 * 足以让 Gemini 生成多章节的对话体文章。
 */
export const FIXTURES: Record<string, { title: string; text: string }> = {
  xRh2sVcNXQ8: {
    title: "对话安德森：AI革命的万亿美金之问",
    text: [
      "Jen: Mark, the new wave of AI companies is showing revenue growth that's hard to believe. What are you seeing?",
      "Mark: The revenue growth in this new wave of AI companies is unprecedented. This is real customer demand turning into money in the bank, and the growth rate is faster than anything I've seen. The leading AI companies and those with breakthrough products are growing faster than any prior cohort.",
      "Mark: The product forms are still very early. I suspect that in five to ten years the products people use will look completely different from today. We still have a long way to go.",
      "Jen: When a company faces a fundamental strategic or economic question, how do firms and venture investors respond differently?",
      "Mark: These are trillion-dollar questions and there are no settled answers yet. Once someone proves a capability is feasible, others can catch up quickly even with fewer resources. As a venture firm, we can place bets on multiple strategies at once. For every strategy we think has a chance, we invest aggressively.",
      "Jen: Is there a gap between what the public says about AI and what they actually do?",
      "Mark: There are two ways to know what people think: ask them, or watch them. In surveys, American voters sound panicked about AI taking jobs. But if you look at their revealed preferences, they're all using AI.",
      "Jen: Where are we in the AI revolution, and what excites you most?",
      "Mark: I think this is the biggest technology revolution of my lifetime, bigger than the internet, comparable to the microprocessor, the steam engine, electricity, even the wheel. Computing followed an 'adding machine' path for eighty years. Neural networks were proposed back in 1943 but we had decades of AI winters. ChatGPT at the end of 2022 finally bore fruit. We're only about three years into the delivery phase of this revolution.",
      "John: A big critique of AI is that revenue is huge but spending grows in lockstep, so it's hard to break even. What do people miss?",
      "Mark: There are two core business models: the consumer model and the enterprise/infrastructure model. Unlike the internet, which took decades of physical buildout, AI rides on top of the internet that already reaches five to six billion people. You can't download electricity or plumbing, but you can download AI. The diffusion speed is light-speed.",
      "Mark: On monetization, AI pricing is more flexible than traditional SaaS. Consumer pricing of two to three hundred dollars a month is becoming normal. On the enterprise side, the value shows up directly in business outcomes: better support, more sales, lower churn. The core model is usage-based tokens.",
      "Mark: Most importantly, the unit cost of AI is falling faster than Moore's law. There's a GPU and data center shortage now, but historically any physically replicable shortage ends in glut. Over the next decade unit costs will plummet and price elasticity will drive far larger demand.",
      "Mark: AWS recently said their GPUs can last seven years or more. This raises the big-model versus small-model debate. Data centers are built around training and serving large models, but a small-model revolution is also happening. Six to twelve months after a frontier model ships, a capable small model appears. China's Kimi model approaches GPT-5 on benchmarks and can run on an ordinary computer.",
      "John: The chip market is in shortage now. How will supply and competition evolve?",
      "John: The historical rule is that shortage becomes glut. Nvidia's success is a flare that attracts AMD, hyperscalers, and Chinese firms. Within five years AI chips will be cheap and plentiful. AI runs on GPUs largely by historical accident; GPUs were designed for games and graphics. If we designed an AI chip from scratch today we'd build something more efficient and specialized.",
      "Mark: Some of the best open-source models now come from China. Is that concerning? How do people in Washington see it?",
      "John: The US-China relationship is complex. Unlike the US-Soviet cold war, the economies are deeply intertwined. DeepSeek's release was a supernova moment. Alibaba's Qwen, Moonshot's Kimi, Tencent, Baidu, and ByteDance are all strong. In robotics, China has a head start thanks to thirty years of electromechanical supply chains.",
      "Jen: Fifty states with fifty different AI laws would put us at a disadvantage. What's the plan?",
      "Mark: Federal risk is now lower; both parties in DC realize they shouldn't pass anything that hinders the US in catching up to China. The pressure has shifted to the states. We're tracking about two hundred AI bills across fifty states. California's SB 1047 mimicked the EU AI Act, which has effectively strangled European AI innovation. The most absurd part required open-source developers to be liable for downstream misuse years later. Fortunately the governor vetoed it.",
      "Jen: Why did a16z decide to step into these policy battles when most stay silent?",
      "Mark: Ben and I think the stakes are too high. This is about the freedom to innovate and the survival of startups. If no one in the industry pushes back on bad policy, we can't control our own destiny.",
      "Jen: Is usage-based or value-based pricing better for AI than per-seat pricing?",
      "Mark: This is a trillion-dollar question. The big cloud players push AI via usage-based pricing, which is wonderful for startups because it removes fixed costs. But token-based pricing isn't the best for every application. A core principle: avoid pricing by cost, price by value. If AI can do the work of a programmer, doctor, or lawyer, price it by the value it creates. And high prices are often underrated; high margins let vendors invest more in R&D and improve the product faster.",
      "Jen: Open source versus closed source, who wins the trillion-dollar question?",
      "Mark: I think it's still open. Closed frontier labs evolve incredibly fast and remain optimistic about scaling. Open-source models keep improving too and are a fantastic educational tool, spreading knowledge globally. AI talent is scarce now, paid more than pro athletes, but scarcity drives surplus as education spreads. The likely answer is both: god-tier models plus a vast market of cheap small models.",
      "John: Two years ago you asked whether incumbents or startups would win. Has the landscape changed?",
      "Mark: It's changed dramatically. Google, Meta, Amazon, and Microsoft are investing with unprecedented aggression. OpenAI and Anthropic are the new incumbents. xAI went from zero to frontier-level in under a year. Application companies once dismissed as 'GPT wrappers' like Cursor are turning into deep tech companies, building their own models. The best AI application companies are full-stack technology companies.",
      "Jen: In your thirty-plus years with Ben Horowitz, where have you disagreed and committed?",
      "Mark: We argue constantly but almost always reach consensus. The most charged topic is our public footprint. The more visible and outspoken we are, the more we attract great founders, but openness carries externalities. We keep balancing how loudly to speak, especially to policymakers.",
      "Jen: There's a lot of talk about AI taking jobs, yet demand for energy and data centers is exploding. Is society ready?",
      "Mark: New technologies always trigger periodic panics, from the printing press to automation fears. People express worry in surveys but embrace AI in their revealed preferences, using ChatGPT for work and even personal and health questions. History shows technology eventually becomes indispensable.",
      "Jen: Will you do cryopreservation?",
      "Mark: With today's technology, no. The track record isn't good. But who knows about the future.",
      "Jen: When your influence is large enough to distort reality, how do you stay grounded?",
      "Mark: Reality distortion is real. My partners are blunt and point out my mistakes. Venture investing exposes you to reality constantly; wins and losses prove whether your analysis was right. Getting humbled is the best way to stay grounded.",
      "Jen: Would you go to Mars if you could?",
      "Mark: Probably not. I don't even like leaving California or my house. Maybe I'll experience it in VR. But I believe Elon can make it happen.",
    ].join("\n"),
  },
};

export function getFixture(videoId: string) {
  return FIXTURES[videoId] ?? null;
}
