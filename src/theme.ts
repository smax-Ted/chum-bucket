import { createTheme, type Theme } from "@openuidev/react-ui/ThemeProvider";

const radius: Theme = {
  radiusS: "3px",
  radiusM: "4px",
  radiusL: "6px",
  radiusXl: "8px",
  radius2xl: "10px",
  radius3xl: "12px",
  radius4xl: "16px",
};

export const chumBucketLight: Theme = createTheme({
  ...radius,

  background: "oklch(0.966 0.006 152)",
  foreground: "oklch(0.995 0.002 150)",
  popoverBackground: "oklch(0.995 0.002 150)",
  invertedBackground: "oklch(0.19 0.014 152)",

  textNeutralPrimary: "oklch(0.19 0.014 152)",
  textNeutralSecondary: "oklch(0.19 0.014 152 / 0.62)",
  textNeutralTertiary: "oklch(0.19 0.014 152 / 0.24)",
  textNeutralLink: "oklch(0.45 0.14 148)",
  textBrand: "oklch(0.45 0.14 148)",

  textAccentPrimary: "oklch(0.99 0.005 150)",
  textAccentSecondary: "oklch(0.99 0.005 150 / 0.6)",
  textAccentTertiary: "oklch(0.99 0.005 150 / 0.3)",

  interactiveAccentDefault: "oklch(0.52 0.155 148)",
  interactiveAccentHover: "oklch(0.47 0.145 148)",
  interactiveAccentPressed: "oklch(0.44 0.135 148)",
  interactiveAccentDisabled: "oklch(0.52 0.155 148 / 0.4)",

  borderDefault: "oklch(0.19 0.014 152 / 0.07)",
  borderInteractive: "oklch(0.19 0.014 152 / 0.14)",
  borderInteractiveEmphasis: "oklch(0.19 0.014 152 / 0.32)",
  borderInteractiveSelected: "oklch(0.19 0.014 152)",
  borderAccent: "oklch(0.52 0.155 148 / 0.18)",
  borderAccentEmphasis: "oklch(0.52 0.155 148 / 0.5)",

  chatUserResponseBg: "oklch(0.19 0.014 152 / 0.07)",
  chatUserResponseText: "oklch(0.19 0.014 152)",
});

export const chumBucketDark: Theme = createTheme({
  ...radius,

  background: "oklch(0.17 0.008 155)",
  foreground: "oklch(0.225 0.01 155)",
  popoverBackground: "oklch(0.245 0.01 155)",
  invertedBackground: "oklch(0.96 0.006 150)",

  textNeutralPrimary: "oklch(0.96 0.006 150)",
  textNeutralSecondary: "oklch(0.96 0.006 150 / 0.62)",
  textNeutralTertiary: "oklch(0.96 0.006 150 / 0.24)",
  textNeutralLink: "oklch(0.8 0.19 149)",
  textBrand: "oklch(0.8 0.19 149)",

  textAccentPrimary: "oklch(0.17 0.03 152)",
  textAccentSecondary: "oklch(0.17 0.03 152 / 0.6)",
  textAccentTertiary: "oklch(0.17 0.03 152 / 0.3)",

  interactiveAccentDefault: "oklch(0.78 0.185 149)",
  interactiveAccentHover: "oklch(0.83 0.175 149)",
  interactiveAccentPressed: "oklch(0.72 0.18 149)",
  interactiveAccentDisabled: "oklch(0.78 0.185 149 / 0.4)",

  borderDefault: "oklch(0.96 0.006 150 / 0.07)",
  borderInteractive: "oklch(0.96 0.006 150 / 0.14)",
  borderInteractiveEmphasis: "oklch(0.96 0.006 150 / 0.4)",
  borderInteractiveSelected: "oklch(0.96 0.006 150)",
  borderAccent: "oklch(0.78 0.185 149 / 0.2)",
  borderAccentEmphasis: "oklch(0.78 0.185 149 / 0.5)",

  chatUserResponseBg: "oklch(0.96 0.006 150 / 0.08)",
  chatUserResponseText: "oklch(0.96 0.006 150)",
});
