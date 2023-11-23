import { CreateRecipeViewLogDto } from '@app/recipe/dto/recipe-view-log/modify-recipe-view-log.dto';
import { RecipeViewLog } from '@app/recipe/entities/recipe-view-log.entity';
import { IRecipeViewLogRepository } from './recipe-view-log.repository.interface';
import { PrismaService } from '@app/common/prisma/prisma.service';
import { CrudPrismaRepository } from '@app/common/repository/crud-prisma.repository';
import { REDIS_PROVIDER } from '@app/common/redis.module';
import { Inject } from '@nestjs/common';
import { RedisClientType } from 'redis';
import { RecipeRepository } from '../recipe/recipe.repository';
import { calcRemainMilliseconsByNextDay } from '@app/common/utils/remain-millisecons-by-next-day';
import { calcPast1MonthDate } from '@app/common/utils/past-1-month';
import { RecipeListViewResponseDto } from '@app/recipe/dto/recipe/filter-recipe.dto';

export class RecipeViewLogRepository
  extends CrudPrismaRepository<RecipeViewLog, CreateRecipeViewLogDto, any, any>
  implements IRecipeViewLogRepository
{
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_PROVIDER) private readonly redisClient: RedisClientType,
    @Inject('PrismaRecipeRepository')
    private readonly recipeRepository: RecipeRepository,
  ) {
    super(prisma, 'recipeViewLog');
  }

  override async create(
    createRecipeViewLogDto: CreateRecipeViewLogDto,
  ): Promise<RecipeViewLog> {
    const createdEntity = this.prisma.recipeViewLog.create({
      data: createRecipeViewLogDto,
    });
    const result = (
      await Promise.all([
        createdEntity,
        this.redisClient.zIncrBy(
          'recipe-view-count',
          1,
          createRecipeViewLogDto.recipe_id.toString(),
        ),
      ])
    )[0];
    return result;
  }

  async checkIfRecipeViewCountKeyExists(): Promise<boolean> {
    return (await this.redisClient.EXISTS('recipe-view-count')) > 0;
  }

  async setAllViewedRecipesInPast1Month() {
    const recipesWithCount = await this.prisma.recipeViewLog.groupBy({
      by: ['recipe_id'],
      _count: true,
      where: {
        created_at: {
          gte: calcPast1MonthDate(),
        },
      },
    });
    await Promise.all(
      recipesWithCount.map((recipeWithCount) => {
        return this.redisClient.ZADD('recipe-view-count', {
          score: recipeWithCount._count,
          value: recipeWithCount.recipe_id.toString(),
        });
      }),
    );
    await this.redisClient.EXPIRE(
      'recipe-view-count',
      Math.floor(calcRemainMilliseconsByNextDay() / 1000),
    );
  }

  async findAll5MostViewedRecipesInPast1Month(): Promise<
    RecipeListViewResponseDto[]
  > {
    if (await this.redisClient.EXISTS('recipe-view-count')) {
      const recipeIdsWithViews = await this.redisClient.zRangeWithScores(
        'recipe-view-count',
        0,
        5,
        {
          REV: true,
        },
      );
      const recipes = await Promise.all(
        recipeIdsWithViews.map((recipeIdWithView) =>
          this.recipeRepository.findOne(parseInt(recipeIdWithView.value)),
        ),
      );
      return recipes.map((recipe, index) => {
        return new RecipeListViewResponseDto(
          recipe.id,
          recipe.name,
          recipe.thumbnail,
          recipe.description,
          recipeIdsWithViews[index].score,
          recipe.created_at,
          recipe.updated_at,
        );
      });
    }
    const recipeIds = await this.prisma.recipeViewLog.groupBy({
      by: ['recipe_id'],
      _count: {
        created_at: true,
      },
      orderBy: {
        _count: {
          created_at: 'desc',
        },
      },
      take: 5,
      where: {
        created_at: {
          gte: calcPast1MonthDate(),
        },
      },
    });
    return await Promise.all(
      recipeIds.map(async (recipeId) => {
        const recipe = await this.recipeRepository.findOne(recipeId.recipe_id);
        return new RecipeListViewResponseDto(
          recipe.id,
          recipe.name,
          recipe.thumbnail,
          recipe.description,
          recipeId._count.created_at,
          recipe.created_at,
          recipe.updated_at,
        );
      }),
    );
  }
}