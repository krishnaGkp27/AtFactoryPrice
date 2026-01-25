import 'package:cloud_firestore/cloud_firestore.dart';

/// Product Model
class Product {
  final String id;
  final String name;
  final String description;
  final double price;
  final String? unit;
  final String category;
  final String? categoryPath;
  final String imageUrl;
  final List<String> images;
  final bool wholesaleAvailable;
  final bool moqFriendly;
  final bool bulkDiscount;
  final bool bestSeller;
  final int? minQuantity;
  final bool inStock;
  final DateTime? createdAt;
  
  Product({
    required this.id,
    required this.name,
    required this.description,
    required this.price,
    this.unit,
    required this.category,
    this.categoryPath,
    required this.imageUrl,
    this.images = const [],
    this.wholesaleAvailable = false,
    this.moqFriendly = false,
    this.bulkDiscount = false,
    this.bestSeller = false,
    this.minQuantity,
    this.inStock = true,
    this.createdAt,
  });
  
  /// Create from Firestore document
  factory Product.fromFirestore(DocumentSnapshot doc) {
    final data = doc.data() as Map<String, dynamic>;
    
    return Product(
      id: doc.id,
      name: data['name'] ?? '',
      description: data['description'] ?? '',
      price: (data['price'] ?? 0).toDouble(),
      unit: data['unit'] ?? data['pricingUnit'],
      category: data['category'] ?? '',
      categoryPath: data['categoryPath'],
      imageUrl: data['imageUrl'] ?? data['image'] ?? '',
      images: List<String>.from(data['images'] ?? []),
      wholesaleAvailable: data['wholesaleAvailable'] == true,
      moqFriendly: data['moqFriendly'] == true,
      bulkDiscount: data['bulkDiscount'] == true,
      bestSeller: data['bestSeller'] == true,
      minQuantity: data['minQuantity'],
      inStock: data['inStock'] != false,
      createdAt: (data['createdAt'] as Timestamp?)?.toDate(),
    );
  }
  
  /// Create from JSON
  factory Product.fromJson(Map<String, dynamic> json) {
    return Product(
      id: json['id'] ?? '',
      name: json['name'] ?? '',
      description: json['description'] ?? '',
      price: (json['price'] ?? 0).toDouble(),
      unit: json['unit'],
      category: json['category'] ?? '',
      categoryPath: json['categoryPath'],
      imageUrl: json['imageUrl'] ?? json['image'] ?? '',
      images: List<String>.from(json['images'] ?? []),
      wholesaleAvailable: json['wholesaleAvailable'] == true,
      moqFriendly: json['moqFriendly'] == true,
      bulkDiscount: json['bulkDiscount'] == true,
      bestSeller: json['bestSeller'] == true,
      minQuantity: json['minQuantity'],
      inStock: json['inStock'] != false,
    );
  }
  
  /// Convert to JSON
  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'name': name,
      'description': description,
      'price': price,
      'unit': unit,
      'category': category,
      'categoryPath': categoryPath,
      'imageUrl': imageUrl,
      'images': images,
      'wholesaleAvailable': wholesaleAvailable,
      'moqFriendly': moqFriendly,
      'bulkDiscount': bulkDiscount,
      'bestSeller': bestSeller,
      'minQuantity': minQuantity,
      'inStock': inStock,
    };
  }
  
  /// Get formatted price
  String get formattedPrice => 'NGN ${price.toStringAsFixed(0).replaceAllMapped(
    RegExp(r'(\d{1,3})(?=(\d{3})+(?!\d))'),
    (Match m) => '${m[1]},'
  )}';
  
  /// Get price label with unit
  String get priceLabel => unit != null ? 'per $unit' : '';
}
