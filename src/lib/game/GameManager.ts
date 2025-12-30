import { RoomState, Player, QuestionPayload } from "./types";
import { db } from "../db";

const MAX_QUESTIONS = 30;
const QUESTION_TIME_SECONDS = 30;
const POINTS_PER_QUESTION = 1;

export class GameManager {
  private rooms: Map<string, RoomState> = new Map();

  createRoom(code: string, hostToken: string): RoomState {
    const normalizedCode = code.toUpperCase();
    const room: RoomState = {
      code: normalizedCode,
      hostToken,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      players: {},
      phase: "lobby",
      questionIndex: -1,
      questionOrder: [],
      currentQ: null,
      correctIndex: null,
      qDeadlineTs: null,
      jokerUsedThisQ: false,
      livePicks: {},
      questionClosed: false,
      revealData: null,
      settings: {
        simultaneousJokers: false, // Default: One joker per round
      },
    };
    this.rooms.set(normalizedCode, room);
    return room;
  }

  getRoom(code: string): RoomState | undefined {
    if (!code) return undefined;
    return this.rooms.get(code.toUpperCase());
  }

  deleteRoom(code: string) {
    if (!code) return;
    const normalizedCode = code.toUpperCase();
    const room = this.rooms.get(normalizedCode);
    if (room) {
      room.phase = "finished"; // Signal loop to stop
      this.rooms.delete(normalizedCode);
    }
  }

  getPublicRooms() {
    const rooms: any[] = [];
    this.rooms.forEach((room) => {
      if (room.phase !== "finished") {
        rooms.push({
          code: room.code,
          playerCount: Object.keys(room.players).length,
          phase: room.phase,
          createdAt: room.createdAt,
        });
      }
    });
    return rooms.sort((a, b) => b.createdAt - a.createdAt);
  }

  handleDisconnect(
    socketId: string
  ): { roomCode: string; playerToken: string } | null {
    for (const room of this.rooms.values()) {
      const player = Object.values(room.players).find(
        (p) => p.socketId === socketId
      );
      if (player) {
        player.connected = false;
        return { roomCode: room.code, playerToken: player.token };
      }
    }
    return null;
  }

  async startGame(room: RoomState, config: any) {
    room.phase = "question";
    room.config = config as any; // Store config

    // Fetch questions based on collectionIds and tagIds

    // Config validation mostly happened on client, but good to be safe.
    const collectionIds = config.collectionIds || [];
    const tagIds = config.tagIds || [];

    if (collectionIds.length > 0 || tagIds.length > 0) {
      // 3. Pool and Deduplication
      // We need to handle ratios, so we might need to keep them grouped first.

      // Map Collection ID -> Set of Question IDs
      const questionsByCollection: Record<string, Set<string>> = {};
      collectionIds.forEach(
        (cid: string) => (questionsByCollection[cid] = new Set())
      );

      // Let's redo the fetch logic slightly to keep track of source
      const qCollections = await db.questionCollection.findMany({
        where: { collectionId: { in: collectionIds } },
        select: { questionId: true, collectionId: true },
      });

      qCollections.forEach((qc) => {
        if (!questionsByCollection[qc.collectionId])
          questionsByCollection[qc.collectionId] = new Set();
        questionsByCollection[qc.collectionId].add(qc.questionId);
      });

      // Filter deleted questions from these sets
      // We can do a bulk check for all involved IDs first
      const allInvolvedIds = new Set<string>();
      qCollections.forEach((qc) => allInvolvedIds.add(qc.questionId));
      if (tagIds.length > 0) {
        const qTags = await db.questionTag.findMany({
          where: { tagId: { in: tagIds } },
          select: { questionId: true },
        });
        qTags.forEach((qt) => allInvolvedIds.add(qt.questionId));
        // We can treat tags as a separate pool or just mix them in later
        // For "consistent" or "custom" ratios, we usually focus on Collections.
        // Tags usually add to the "General Pool".
      }

      const validQuestions = await db.question.findMany({
        where: {
          id: { in: Array.from(allInvolvedIds) },
          deletedAt: null,
        },
        select: { id: true },
      });
      const validIdSet = new Set(validQuestions.map((q) => q.id));

      // Now build the final list based on strategy
      let finalIds: string[] = [];
      const strategy = config.ratioStrategy || "by_collection";
      const totalNeeded = config.totalQuestions || 30;

      if (strategy === "consistent" && collectionIds.length > 0) {
        const countPerCol = Math.floor(totalNeeded / collectionIds.length);

        collectionIds.forEach((cid: string) => {
          const available = Array.from(questionsByCollection[cid] || []).filter(
            (id) => validIdSet.has(id)
          );
          const shuffle = (arr: any[]) => arr.sort(() => Math.random() - 0.5);
          const picked = shuffle(available).slice(0, countPerCol);
          finalIds.push(...picked);
        });

        // Fill remainder
        const currentCount = new Set(finalIds).size;
        if (currentCount < totalNeeded) {
          const used = new Set(finalIds);
          const remainder = Array.from(allInvolvedIds).filter(
            (id) => validIdSet.has(id) && !used.has(id)
          );
          const shuffle = (arr: any[]) => arr.sort(() => Math.random() - 0.5);
          finalIds.push(
            ...shuffle(remainder).slice(0, totalNeeded - currentCount)
          );
        }
      } else if (strategy === "custom" && config.customRatios) {
        Object.entries(config.customRatios).forEach(([cid, count]) => {
          const target = Number(count);
          if (target > 0 && questionsByCollection[cid]) {
            const available = Array.from(questionsByCollection[cid]).filter(
              (id) => validIdSet.has(id)
            );
            const shuffle = (arr: any[]) => arr.sort(() => Math.random() - 0.5);
            const picked = shuffle(available).slice(0, target);
            finalIds.push(...picked);
          }
        });
        // Fill remainder
        const currentCount = new Set(finalIds).size;
        if (currentCount < totalNeeded) {
          const used = new Set(finalIds);
          const remainder = Array.from(allInvolvedIds).filter(
            (id) => validIdSet.has(id) && !used.has(id)
          );
          const shuffle = (arr: any[]) => arr.sort(() => Math.random() - 0.5);
          finalIds.push(
            ...shuffle(remainder).slice(0, totalNeeded - currentCount)
          );
        }
      } else {
        // by_collection (Default) - Pool everything
        const available = Array.from(allInvolvedIds).filter((id) =>
          validIdSet.has(id)
        );
        const shuffle = (arr: any[]) => arr.sort(() => Math.random() - 0.5);
        finalIds = shuffle(available).slice(0, totalNeeded);
      }

      // Final Shuffle to mix the sources
      const shuffle = (arr: any[]) => arr.sort(() => Math.random() - 0.5);
      room.questionOrder = shuffle(Array.from(new Set(finalIds))).map(
        String
      ) as any;
    } else {
      // Fallback to old behavior: Fetch all
      const questions = await db.question.findMany({
        where: { deletedAt: null },
        select: { id: true },
      });
      const allIds = questions.map((q) => q.id);
      const shuffle = (arr: any[]) => arr.sort(() => Math.random() - 0.5);
      room.questionOrder = shuffle(allIds).slice(0, 30) as any;
    }

    room.questionIndex = -1;

    Object.values(room.players).forEach((p) => {
      p.score = 0;
      p.joker5050 = true;
      p.jokerSpy = true;
      p.jokerRisk = true;
    });

    await this.nextQuestion(room);
  }

  async nextQuestion(room: RoomState) {
    room.questionIndex++;
    room.jokerUsedThisQ = false;
    room.questionClosed = false;
    room.revealData = null;
    room.currentQ = null;
    room.qDeadlineTs = null;
    room.livePicks = {};
    room.paused = false;
    room.pauseRemaining = undefined;

    Object.values(room.players).forEach((p) => {
      p.selectedChoice = null;
      p.usedRiskThisQ = false;
      p.usedSpyThisQ = false;
      p.used5050ThisQ = false;
      room.livePicks[p.token] = null;
    });

    if (room.questionIndex >= room.questionOrder.length) {
      room.phase = "finished";
      return;
    }

    const qId = room.questionOrder[room.questionIndex];
    const q = await db.question.findUnique({ where: { id: String(qId) } });

    if (!q) {
      room.phase = "finished";
      return;
    }

    const options = JSON.parse(q.options) as string[];

    room.currentQ = {
      text: q.text,
      choices: options,
    };
    room.correctIndex = q.correctIndex;
    room.phase = "question";
    room.qDeadlineTs = Date.now() + QUESTION_TIME_SECONDS * 1000;
  }

  // Explicit helper for calculating points
  getPointsForQuestion(index: number): number {
    // q1-2 (idx 0,1) -> 1pt
    // q3-4 (idx 2,3) -> 2pts
    // q5-6 (idx 4,5) -> 3pts
    return Math.floor(index / 2) + 1;
  }

  async revealAnswer(room: RoomState) {
    room.phase = "reveal";
    room.qDeadlineTs = null;

    // Calculate Scores & Populate Reveal Data
    const correctIdx = room.correctIndex;
    if (correctIdx === null) return;

    room.revealData = {
      correctIndex: correctIdx,
      picksByChoice: { 0: [], 1: [], 2: [], 3: [] },
      pointsForThisRound: this.getPointsForQuestion(room.questionIndex),
    };

    const basePoints = this.getPointsForQuestion(room.questionIndex);

    Object.values(room.players).forEach((p) => {
      if (p.selectedChoice !== null) {
        // Add to reveal data
        if (!room.revealData!.picksByChoice[p.selectedChoice]) {
          room.revealData!.picksByChoice[p.selectedChoice] = [];
        }
        room.revealData!.picksByChoice[p.selectedChoice].push({
          name: p.name,
          avatar: p.avatar,
          token: p.token,
        });

        // Score Logic
        if (p.selectedChoice === correctIdx) {
          let points = basePoints;
          if (p.usedRiskThisQ) {
            points *= 2; // Double points
          }
          p.score += points;
        } else {
          // Wrong Answer
          if (p.usedRiskThisQ) {
            p.score -= basePoints; // Deduct logic
          }
        }
      }
    });
  }
}

export const gameManager = new GameManager();
