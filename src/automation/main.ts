import { startService } from "./service.js";

// Fixed service entry point. Tokens and prompts never appear in process arguments.
startService(process.env)
  .then((service) => {
    const stop = () => {
      void service.stop().then(
        () => {
          process.exitCode = 0;
        },
        () => {
          process.exitCode = 1;
        },
      );
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  })
  .catch(() => {
    process.stderr.write(
      "Code60 scheduler could not start. Check private storage and service ownership.\n",
    );
    process.exitCode = 1;
  });
