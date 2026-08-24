export const metadata = {
  title: "USTAL Admin",
  description: "Внутренняя админка USTAL — не является частью пользовательского приложения",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, background: "#f5f5f7" }}>
        {children}
      </body>
    </html>
  );
}
