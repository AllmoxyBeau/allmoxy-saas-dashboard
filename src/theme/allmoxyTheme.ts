import { createTheme } from '@mui/material/styles';

/**
 * Allmoxy brand theme (dark mode).
 *
 * Sourced from the `allmoxy-brand-mui` skill. Do not deviate from these values
 * without updating the skill first — every Allmoxy surface should share this theme.
 *
 * Palette reference:
 *   Electric Blue #2C73FF — primary actions, links, active states
 *   Midnight      #0D1117 — app shell background
 *   Gunmetal      #161B22 — card/panel surfaces
 *   Slate         #21262D — borders, dividers
 *   White         #FFFFFF — primary text on dark
 *   Cloud         #8B949E — secondary text on dark
 *   Success       #1A9E5C
 *   Warning       #F5A623
 *   Error         #E53E3E
 */
export const allmoxyTheme = createTheme({
  palette: {
    mode: 'dark',
    primary: {
      main: '#2C73FF',
      dark: '#1A5FE8',
      contrastText: '#FFFFFF',
    },
    background: {
      default: '#0D1117',
      paper: '#161B22',
    },
    text: {
      primary: '#FFFFFF',
      secondary: '#8B949E',
    },
    divider: '#21262D',
    success: { main: '#1A9E5C' },
    warning: { main: '#F5A623' },
    error: { main: '#E53E3E' },
    info: { main: '#2C73FF' },
  },
  typography: {
    fontFamily: '"Roboto", "Helvetica", "Arial", sans-serif',
    h1: { fontWeight: 500, letterSpacing: '0.01em' },
    h2: { fontWeight: 500, letterSpacing: '0.01em' },
    h3: { fontWeight: 500, letterSpacing: '0.01em' },
    h4: { fontWeight: 500, letterSpacing: '0.01em' },
    h5: { fontWeight: 500 },
    h6: { fontWeight: 500 },
    body1: { fontWeight: 400, lineHeight: 1.5 },
    body2: { fontWeight: 400, lineHeight: 1.5 },
    button: {
      // Allmoxy never all-caps button labels.
      textTransform: 'none',
      fontWeight: 500,
    },
  },
  shape: {
    borderRadius: 6,
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          backgroundColor: '#0D1117',
          color: '#FFFFFF',
        },
      },
    },
    MuiButton: {
      defaultProps: {
        disableElevation: true,
      },
      styleOverrides: {
        root: {
          borderRadius: 6,
          fontWeight: 500,
        },
        containedPrimary: {
          backgroundColor: '#2C73FF',
          '&:hover': {
            backgroundColor: '#1A5FE8',
          },
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          // MUI v5 adds a subtle gradient overlay to Paper — remove it for flat Allmoxy surfaces.
          backgroundImage: 'none',
          border: '1px solid #21262D',
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          border: '1px solid #21262D',
        },
      },
    },
    MuiTableCell: {
      styleOverrides: {
        root: {
          borderColor: '#21262D',
        },
        head: {
          fontWeight: 500,
          color: '#8B949E',
        },
      },
    },
    MuiTabs: {
      styleOverrides: {
        root: {
          borderBottom: '1px solid #21262D',
        },
        indicator: {
          backgroundColor: '#2C73FF',
        },
      },
    },
    MuiTab: {
      styleOverrides: {
        root: {
          color: '#8B949E',
          textTransform: 'none',
          fontWeight: 400,
          minHeight: 48,
          '&.Mui-selected': {
            color: '#2C73FF',
            fontWeight: 500,
          },
        },
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          '& fieldset': { borderColor: '#21262D' },
          '&:hover fieldset': { borderColor: '#2C73FF' },
          '&.Mui-focused fieldset': { borderColor: '#2C73FF' },
        },
      },
    },
    MuiTooltip: {
      styleOverrides: {
        tooltip: {
          backgroundColor: '#161B22',
          color: '#FFFFFF',
          border: '1px solid #21262D',
          fontSize: 12,
          lineHeight: 1.5,
          padding: '6px 10px',
          maxWidth: 360,
        },
        arrow: {
          color: '#161B22',
          '&::before': {
            border: '1px solid #21262D',
          },
        },
      },
    },
  },
});

export default allmoxyTheme;
