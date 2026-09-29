import { ThemeProvider, useSystemThemeMode } from "@openuidev/react-ui/ThemeProvider";
import type { FC, ReactNode } from "react";
import { chumBucketDark, chumBucketLight } from "./theme";

export const Provider: FC<{ children: ReactNode }> = ({ children }) => {
  const systemMode = useSystemThemeMode();

  return (
    <ThemeProvider mode={systemMode} lightTheme={chumBucketLight} darkTheme={chumBucketDark}>
      {children}
    </ThemeProvider>
  );
};
