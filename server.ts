import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import { createServer as createViteServer } from "vite";
import path from "path";
import { spawn, ChildProcess } from "child_process";
import fs from "fs-extra";

import { initializeApp } from "firebase/app";

import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
} from "firebase/firestore";

import pkg from "lodash";

const { debounce } = pkg;

// Firebase Config
const firebaseConfig = fs.readJsonSync(
  path.join(process.cwd(), "firebase-applet-config.json")
);

// Firebase Client SDK
const firebaseApp = initializeApp(firebaseConfig);

const db = getFirestore(firebaseApp);

const PORT = process.env.PORT || 3000;

async function startServer() {
  const app = express();

  app.use(cors());

  app.use(express.json());

  const httpServer = createServer(app);

  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
    transports: ["websocket", "polling"],
  });

  // Room Storage
  const rooms = new Map<
    string,
    {
      files: Record<
        string,
        {
          content: string;
          language: string;
        }
      >;

      activeFile: string;

      canvas: any[];

      users: Map<
        string,
        {
          username: string;
          color: string;
        }
      >;
    }
  >();

  // Running Processes
  const runningProcesses = new Map<
    string,
    ChildProcess
  >();

  // Save Room
  const saveRoomToFirestore = debounce(
    async (roomId: string) => {
      const room = rooms.get(roomId);

      if (!room) return;

      try {
        await setDoc(
          doc(db, "sessions", roomId),
          {
            files: room.files,

            activeFile: room.activeFile,

            canvas: room.canvas,

            updatedAt: new Date(),
          },
          {
            merge: true,
          }
        );
      } catch (error) {
        console.error(
          "[Firestore Save Error]",
          error
        );
      }
    },

    2000
  );

  // Socket.IO
  io.on("connection", (socket) => {
    console.log(
      "User Connected:",
      socket.id
    );

    socket.on(
      "join-room",

      async ({
        roomId,
        username,
        color,
      }) => {
        socket.join(roomId);

        if (!rooms.has(roomId)) {
          try {
            const docRef = doc(
              db,
              "sessions",
              roomId
            );

            const docSnap =
              await getDoc(docRef);

            if (docSnap.exists()) {
              const data = docSnap.data();

              rooms.set(roomId, {
                files: data.files || {},

                activeFile:
                  data.activeFile ||
                  "main.js",

                canvas:
                  data.canvas || [],

                users: new Map(),
              });
            } else {
              const initialState = {
                files: {
                  "main.js": {
                    content:
                      '// Welcome to CodeCanvas\nconsole.log("Hello World");',

                    language:
                      "javascript",
                  },
                },

                activeFile:
                  "main.js",

                canvas: [],

                users: new Map(),
              };

              rooms.set(
                roomId,
                initialState
              );

              await setDoc(
                doc(
                  db,
                  "sessions",
                  roomId
                ),

                {
                  files:
                    initialState.files,

                  activeFile:
                    initialState.activeFile,

                  canvas:
                    initialState.canvas,

                  updatedAt:
                    new Date(),
                }
              );
            }
          } catch (error) {
            console.error(
              "[Firestore Error]",
              error
            );

            rooms.set(roomId, {
              files: {
                "main.js": {
                  content:
                    "// Error loading room",

                  language:
                    "javascript",
                },
              },

              activeFile:
                "main.js",

              canvas: [],

              users: new Map(),
            });
          }
        }

        const room =
          rooms.get(roomId)!;

        room.users.set(socket.id, {
          username,
          color,
        });

        socket.emit("room-init", {
          files: room.files,

          activeFile:
            room.activeFile,

          canvas: room.canvas,

          users: Array.from(
            room.users.values()
          ),
        });

        socket
          .to(roomId)
          .emit("user-joined", {
            username,
            color,
            id: socket.id,
          });

        io.to(roomId).emit(
          "update-users",

          Array.from(
            room.users.values()
          )
        );
      }
    );

    // Code Change
    socket.on(
      "code-change",

      ({
        roomId,
        files,
        activeFile,
      }) => {
        const room =
          rooms.get(roomId);

        if (room) {
          room.files = files;

          room.activeFile =
            activeFile;

          socket
            .to(roomId)
            .emit(
              "code-update",
              {
                files,
                activeFile,
              }
            );

          saveRoomToFirestore(
            roomId
          );
        }
      }
    );

    // Canvas Change
    socket.on(
      "canvas-change",

      ({
        roomId,
        drawingData,
      }) => {
        const room =
          rooms.get(roomId);

        if (room) {
          room.canvas.push(
            drawingData
          );

          socket
            .to(roomId)
            .emit(
              "canvas-update",
              drawingData
            );

          saveRoomToFirestore(
            roomId
          );
        }
      }
    );

    // Clear Canvas
    socket.on(
      "canvas-clear",

      (roomId) => {
        const room =
          rooms.get(roomId);

        if (room) {
          room.canvas = [];

          io.to(roomId).emit(
            "canvas-cleared"
          );

          saveRoomToFirestore(
            roomId
          );
        }
      }
    );

    // Chat Messages
    socket.on(
      "send-message",

      ({ roomId, message }) => {
        io.to(roomId).emit(
          "new-message",
          message
        );
      }
    );

    // Terminal
    socket.on(
      "terminal-input",

      async ({
        roomId,
        input,
      }) => {
        const room =
          rooms.get(roomId);

        if (!room) return;

        const proc =
          runningProcesses.get(
            roomId
          );

        if (
          proc &&
          proc.stdin
        ) {
          proc.stdin.write(
            input + "\n"
          );
        } else {
          try {
            const projectDir =
              path.join(
                process.cwd(),
                "temp",
                roomId
              );

            await fs.ensureDir(
              projectDir
            );

            const cmdParts =
              input
                .trim()
                .split(" ");

            if (cmdParts[0]) {
              const newProc =
                spawn(
                  cmdParts[0],
                  cmdParts.slice(
                    1
                  ),

                  {
                    cwd: projectDir,

                    shell: true,
                  }
                );

              runningProcesses.set(
                roomId,
                newProc
              );

              const emitOutput =
                (
                  output: string
                ) =>
                  io.to(
                    roomId
                  ).emit(
                    "terminal-output",
                    {
                      output,
                    }
                  );

              emitOutput(
                `\r\n> ${input}\r\n`
              );

              newProc.stdout.on(
                "data",

                (d) =>
                  emitOutput(
                    d.toString()
                  )
              );

              newProc.stderr.on(
                "data",

                (d) =>
                  emitOutput(
                    d.toString()
                  )
              );

              newProc.on(
                "close",

                (c) => {
                  runningProcesses.delete(
                    roomId
                  );

                  emitOutput(
                    `\r\n> Process exited with code ${c}\r\n`
                  );
                }
              );
            }
          } catch (err: any) {
            io.to(roomId).emit(
              "terminal-output",

              {
                output: `\r\nError executing command: ${err.message}\r\n`,
              }
            );
          }
        }
      }
    );

    // Disconnect
    socket.on(
      "disconnecting",

      () => {
        for (const roomId of socket.rooms) {
          const room =
            rooms.get(roomId);

          if (room) {
            room.users.delete(
              socket.id
            );

            io.to(roomId).emit(
              "update-users",

              Array.from(
                room.users.values()
              )
            );
          }
        }
      }
    );
  });

  // Health API
  app.get(
    "/api/health",

    (req, res) => {
      res.json({
        status: "ok",
      });
    }
  );

  // Development
  if (
    process.env.NODE_ENV !==
    "production"
  ) {
    const vite =
      await createViteServer({
        server: {
          middlewareMode: true,
        },

        appType: "spa",
      });

    app.use(vite.middlewares);
  }

  // Production
  else {
    const distPath =
      path.resolve(
        process.cwd(),
        "dist"
      );

    console.log(
      "DIST PATH:",
      distPath
    );

    console.log(
      "DIST EXISTS:",
      fs.existsSync(
        distPath
      )
    );

    app.use(
      express.static(
        distPath
      )
    );

    app.get("*", (req, res) => {
      res.sendFile(
        path.join(
          distPath,
          "index.html"
        )
      );
    });
  }

  httpServer.listen(
    PORT,
    "0.0.0.0",

    () => {
      console.log(
        `Server running on port ${PORT}`
      );
    }
  );
}

startServer().catch((err) => {
  console.error(
    "Startup Error:",
    err
  );

  process.exit(1);
});