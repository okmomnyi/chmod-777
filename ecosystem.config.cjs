/**
 * PM2 Ecosystem config
 *
 * Two processes:
 *   ctf-bot    — Telegram bot (handles user commands, push notifications)
 *   ctf-runner — Worker pool (runs in the same process as the bot via imports,
 *                but can be split if you want a separate runner process)
 *
 * Run: pm2 start ecosystem.config.cjs
 */
module.exports = {
  apps: [
    {
      name: "ctf-bot",
      script: "src/bot.ts",
      interpreter: "node",
      interpreter_args: "--import tsx/esm",
      cwd: __dirname,
      watch: false,
      env: {
        NODE_ENV: "production",
      },
      error_file: "logs/bot-error.log",
      out_file: "logs/bot-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      restart_delay: 5000,
      max_restarts: 10,
    },
  ],
};
