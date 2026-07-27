"use client";

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { MotionConfig } from "framer-motion";
import { spring } from "@/lib/motion";

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );

  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem={false}
      themes={["light", "dark"]}
      disableTransitionOnChange
    >
      <QueryClientProvider client={queryClient}>
        {/* One spring feel app-wide; auto-respects prefers-reduced-motion. */}
        <MotionConfig reducedMotion="user" transition={spring}>
          {children}
        </MotionConfig>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
