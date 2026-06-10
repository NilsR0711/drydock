"use client";

// Root-layout failure boundary. Replaces the entire document, so globals.css /
// fonts / theme providers are unavailable — styling must be self-contained.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "hsl(220 18% 7%)",
          color: "hsl(220 14% 92%)",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
        }}
      >
        <div style={{ maxWidth: 420, padding: 24, textAlign: "center" }}>
          <h1 style={{ fontSize: 18, fontWeight: 700, margin: "0 0 8px" }}>
            Drydock hit an unexpected error
          </h1>
          <p style={{ fontSize: 14, color: "hsl(220 10% 62%)", margin: "0 0 20px" }}>
            {error.message || "The application failed to render."}
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              border: "1px solid hsl(220 14% 22%)",
              background: "hsl(220 16% 12%)",
              color: "inherit",
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
