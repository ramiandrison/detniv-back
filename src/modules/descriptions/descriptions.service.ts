import { prisma } from '../../config/prisma';

const MAX_TEMPLATES_PER_USER = 50;

export const listDescriptions = (userId: number) =>
  prisma.descriptionTemplate.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, name: true, text: true, createdAt: true, updatedAt: true },
  });

export const createDescription = async (userId: number, name: string, text: string) => {
  const count = await prisma.descriptionTemplate.count({ where: { userId } });
  if (count >= MAX_TEMPLATES_PER_USER) {
    throw new Error('Too many descriptions');
  }
  return prisma.descriptionTemplate.create({
    data: { userId, name, text },
    select: { id: true, name: true, text: true, createdAt: true, updatedAt: true },
  });
};

export const deleteDescription = async (userId: number, id: number) => {
  const { count } = await prisma.descriptionTemplate.deleteMany({
    where: { id, userId },
  });
  if (count === 0) throw new Error('Description not found');
};
