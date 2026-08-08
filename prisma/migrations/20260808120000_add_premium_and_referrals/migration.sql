-- Премиум-подписка и реферальная программа
--
-- premiumUntil хранит дату окончания, а не флаг: продление — это сдвиг даты,
-- и не нужен фоновый процесс, снимающий премиум по расписанию.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "premiumUntil" TIMESTAMP(3),
ADD COLUMN     "referredBy" BIGINT,
ADD COLUMN     "referralCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "payments" (
    "id" SERIAL NOT NULL,
    "userId" BIGINT NOT NULL,
    "stars" INTEGER NOT NULL,
    "days" INTEGER NOT NULL,
    "telegramChargeId" TEXT NOT NULL,
    "refunded" BOOLEAN NOT NULL DEFAULT false,
    "refundedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Уникальность идентификатора платежа Telegram — защита от двойного
-- начисления, если successful_payment придёт повторно
CREATE UNIQUE INDEX "payments_telegramChargeId_key" ON "payments"("telegramChargeId");

-- CreateIndex
CREATE INDEX "payments_userId_idx" ON "payments"("userId");

-- CreateIndex
CREATE INDEX "payments_createdAt_idx" ON "payments"("createdAt");

-- CreateIndex
CREATE INDEX "users_premiumUntil_idx" ON "users"("premiumUntil");

-- CreateIndex
CREATE INDEX "users_referredBy_idx" ON "users"("referredBy");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
