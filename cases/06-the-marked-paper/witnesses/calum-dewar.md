# Statement: Calum Dewar, lead developer

Taken 22 September 2026.

The assistant is a small service. A request comes in over HTTPS to the adapter, which checks the resident's session token and the body size, then hands the request to the handler, which runs the agent. The body limit is 1 MiB. That was the platform default and nobody changed it.

The eval suite has five cases covering application status, consultation dates, conservation areas and two guidance questions. It runs nightly and has passed every night since launch. To keep it fast, the suite runs inside the test process against the same handler code that production uses, so what it tests is what residents get.

The constraints map is run by another department and times out under load in office hours. We see 504s from it most days. I assumed the error pages were that.

Nobody has changed the model or the prompt since 2 September.
