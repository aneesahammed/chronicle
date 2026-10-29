
  (function () {
    try {
      var saved = localStorage.getItem("chronicle-theme");
      var theme = saved || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      document.documentElement.setAttribute("data-theme", theme);
      document.getElementById("themeColor")?.setAttribute("content", theme === "dark" ? "#0c0e12" : "#f7f8fa");
    } catch (_) {
      document.documentElement.setAttribute("data-theme", "light");
    }
  })();
