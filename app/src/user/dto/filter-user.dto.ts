import { Diet } from '../types/diet.enum';

export class FilterUserDto {
  nickname?: string;
  user_id?: string;
  email?: string;
  diet?: Diet;
}
