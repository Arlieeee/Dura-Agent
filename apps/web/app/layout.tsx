import './globals.css';
export const metadata = { title: 'Dura-Agent', description: '素瓷·墨 · 事件驱动 Agent' };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
