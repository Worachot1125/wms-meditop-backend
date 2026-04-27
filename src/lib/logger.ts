const formatThaiTime = () => {
  return new Date().toLocaleString("th-TH", {
    timeZone: "Asia/Bangkok",
    hour12: false,
  });
};

export const logger = {
  info: (...msg: any[]) => {
    console.log(`ℹ️ [${formatThaiTime()}]`, ...msg);
  },

  error: (...msg: any[]) => {
    console.error(`❌ [${formatThaiTime()}]`, ...msg);
  },

  warn: (...msg: any[]) => {
    console.warn(`⚠️ [${formatThaiTime()}]`, ...msg);
  },
};
