# Orchestration patterns

Each pattern is only `dispatch start` plus `SendMessage`; the specs decide who talks to whom. A **worker** is a session you dispatch.

## Select

Use one of these directly:

| Pattern | When |
|---|---|
| Request-reply | The default |
| Handoff | The user passed `--handoff` or asked for no reply |
| Orchestrator-workers | The task splits into parts that do not depend on each other |

Propose these first, unless the user named one. Each adds steps, rounds or sessions the user did not ask for.

| Pattern | Fits when |
|---|---|
| Prompt chaining | A step needs the previous step's output |
| Evaluator-optimizer | There is a clear acceptance bar and a second look improves the result |
| Hierarchical | A part is itself large enough to split |
| Human-in-the-loop | The spec leaves a choice the user should make |

## Request-reply

One worker, one reply. The reply can go to any peer. When another session owns the work and should act on the result, name it in the reply line, and ask for a one-line note to you as well, so you know the worker finished.

## Handoff

One worker, no reply line. The worker owns the task, and you save the turn a reply costs.

## Orchestrator-workers

One worker per independent part, all started before you wait on any. They run at the same time, and each holds only its own part in context. Give each a unique `--name` and one shared `--group`, then combine the replies.

## Prompt chaining

Workers in sequence; each spec carries the previous reply. You check each output before you start the next step, and stop the chain when a check fails.

## Evaluator-optimizer

A generator and an evaluator that message each other until the evaluator accepts. A separate evaluator judges the work with fresh eyes. Give each the other's name, and cap the rounds in both specs: `stop after 3 rounds and send what you have`.

## Hierarchical

A worker that dispatches its own workers and replies once they all have. Your context then holds one reply per part instead of one per leaf. Its spec says to wait for its workers and to give them its own peer name.

## Human-in-the-loop

Add to the worker's spec: `When you need a decision, ask <your peer name> with the SendMessage tool and keep working on what does not depend on the answer.` Ask the user when the decision is theirs, and reply with `SendMessage`. You can steer a running worker the same way at any time.
